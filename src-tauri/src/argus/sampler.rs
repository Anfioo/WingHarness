//! The snapshot sampling thread and its `Channel<Snapshot>` subscription.
//!
//! One thread serves the whole app. A page mounts, subscribes with a channel
//! and an interval, and receives a frame per tick. With background monitoring
//! on, dropping the subscription keeps the thread alive at the background
//! interval and feeds the history recorder; otherwise the thread stops and the
//! next page mount spawns a fresh one. The thread owns the collector, the
//! service clients and the history recorder, and never touches `ArgusState` or
//! performs a service round trip while a lock is held.

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use argus_core::history::{self, HistoryRecorder};
use argus_core::meta::MetaStore;
use argus_core::models::{
    DEFAULT_BACKGROUND_INTERVAL_MS, DEFAULT_INTERVAL_MS, MAX_BACKGROUND_INTERVAL_MS,
    MIN_BACKGROUND_INTERVAL_MS,
};
use argus_core::{Collector, Snapshot};
use argus_service::{DiskClient, NetworkClient};
use tauri::ipc::Channel;

use crate::argus::store;

/// ETW session for per-process network traffic. The development name differs so
/// a dev build never stops an installed build's session.
const NETWORK_SESSION: &str = if cfg!(debug_assertions) {
    "WingHarness Task Manager Network (dev)"
} else {
    "WingHarness Task Manager Network"
};

pub enum Control {
    /// Deliver frames to this channel at this interval, replacing any previous
    /// subscriber.
    Subscribe(Channel<Snapshot>, u64),
    SetInterval(u64),
    /// Take a frame now, e.g. right after a process action.
    Refresh,
    /// Drop the subscriber without stopping the thread. When background
    /// monitoring is on the thread keeps running for the history recorder.
    Unsubscribe,
    /// Keep sampling with no subscriber, at the background interval.
    SetBackground(bool),
    SetBackgroundInterval(u64),
    /// Attach or detach the history recorder's directory.
    SetHistoryDir(Option<PathBuf>),
    /// Remove every history file and report the result on the sender.
    ClearHistory(PathBuf, Sender<std::io::Result<()>>),
    /// Stop the thread and drop the collector.
    Stop,
}

pub struct Sampler {
    tx: Sender<Control>,
    handle: Option<JoinHandle<()>>,
}

impl Sampler {
    /// Starts the sampling thread. The collector is built there, so its setup
    /// overlaps the page's startup instead of delaying the command. `meta` is
    /// shared with the host, which serves the cached icons to the page.
    pub fn spawn(meta: Arc<MetaStore>) -> Self {
        let (tx, rx) = mpsc::channel::<Control>();
        let handle = std::thread::Builder::new()
            .name("wingharness-argus-sampler".into())
            .spawn(move || run(rx, meta))
            .expect("spawn the task manager sampler thread");
        Self {
            tx,
            handle: Some(handle),
        }
    }

    /// Sends a control message; `false` means the thread has already exited,
    /// so this handle can no longer deliver anything.
    pub fn send(&self, control: Control) -> bool {
        self.tx.send(control).is_ok()
    }

    /// Whether the thread has already exited, so its handle can be replaced.
    pub fn is_finished(&self) -> bool {
        self.handle
            .as_ref()
            .map_or(true, |handle| handle.is_finished())
    }

    /// Stops the thread and waits for it to release the trace session, so a
    /// thread started right after never shares its ETW session.
    pub fn stop(mut self) {
        let _ = self.tx.send(Control::Stop);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// How the thread waits for its next control message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WaitMode {
    /// A page is subscribed: sample at the foreground interval.
    Foreground,
    /// Nobody is subscribed but background monitoring is on: sample at the
    /// background interval for the history recorder.
    Background,
    /// Nobody is subscribed and background monitoring is off: block until a
    /// control arrives, without sampling.
    Idle,
}

fn wait_mode(subscribed: bool, background: bool) -> WaitMode {
    if subscribed {
        WaitMode::Foreground
    } else if background {
        WaitMode::Background
    } else {
        WaitMode::Idle
    }
}

/// How long to wait for a control before sampling; `None` blocks until one
/// arrives.
fn timeout_for(
    mode: WaitMode,
    interval: Duration,
    background_interval: Duration,
) -> Option<Duration> {
    match mode {
        WaitMode::Foreground => Some(interval),
        WaitMode::Background => Some(background_interval),
        WaitMode::Idle => None,
    }
}

/// The control or timeout the thread just processed, reduced to what the
/// lifecycle decision depends on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Signal {
    /// A subscription or a refresh asks for a frame now.
    Demand,
    /// A timed wait elapsed.
    Timeout,
    /// The page dropped its subscription.
    Unsubscribe,
    /// Background monitoring turned off.
    BackgroundOff,
    /// The thread was asked to stop, or its control channel closed.
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Sample,
    Wait,
    Exit,
}

fn next_action(signal: Signal, subscribed: bool, background: bool) -> Action {
    match signal {
        Signal::Demand => Action::Sample,
        // An idle thread blocks, so a timeout only happens while a frame is
        // wanted, for the page or for the history recorder.
        Signal::Timeout if subscribed || background => Action::Sample,
        Signal::Unsubscribe if !background => Action::Exit,
        Signal::BackgroundOff if !subscribed && !background => Action::Exit,
        Signal::Stop => Action::Exit,
        _ => Action::Wait,
    }
}

/// The history recorder together with the directory it was opened for, so a
/// clear request can go through the open day file when it names that directory.
struct HistoryTarget {
    dir: PathBuf,
    recorder: HistoryRecorder,
}

impl HistoryTarget {
    fn new(dir: PathBuf) -> Self {
        Self {
            recorder: HistoryRecorder::new(dir.clone()),
            dir,
        }
    }
}

fn run(rx: Receiver<Control>, meta: Arc<MetaStore>) {
    let mut collector = Collector::new(meta);
    // Needs administrator rights; without them the network columns stay empty.
    collector.enable_process_network(NETWORK_SESSION);
    let mut network = NetworkClient::spawn();
    let mut disk = DiskClient::spawn();
    let mut subscriber: Option<Channel<Snapshot>> = None;
    let mut interval = Duration::from_millis(store::clamp_interval(DEFAULT_INTERVAL_MS));
    let mut background = false;
    let mut background_interval = Duration::from_millis(DEFAULT_BACKGROUND_INTERVAL_MS);
    let mut history: Option<HistoryTarget> = None;

    loop {
        let mode = wait_mode(subscriber.is_some(), background);
        let received = match timeout_for(mode, interval, background_interval) {
            Some(wait) => rx.recv_timeout(wait),
            // Nothing is listening and background monitoring is off: block
            // until the page subscribes, instead of waking up for frames
            // nobody wants.
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };

        let signal = match received {
            Err(RecvTimeoutError::Timeout) => Signal::Timeout,
            Err(RecvTimeoutError::Disconnected) => Signal::Stop,
            Ok(Control::Subscribe(channel, interval_ms)) => {
                interval = Duration::from_millis(store::clamp_interval(interval_ms));
                subscriber = Some(channel);
                Signal::Demand
            }
            Ok(Control::SetInterval(interval_ms)) => {
                interval = Duration::from_millis(store::clamp_interval(interval_ms));
                continue;
            }
            Ok(Control::Refresh) => {
                // A refresh with no page to show it to is wasted work.
                if subscriber.is_none() {
                    continue;
                }
                Signal::Demand
            }
            Ok(Control::Unsubscribe) => {
                subscriber = None;
                Signal::Unsubscribe
            }
            Ok(Control::SetBackground(on)) => {
                background = on;
                if on {
                    continue;
                }
                Signal::BackgroundOff
            }
            Ok(Control::SetBackgroundInterval(interval_ms)) => {
                background_interval = Duration::from_millis(
                    interval_ms.clamp(MIN_BACKGROUND_INTERVAL_MS, MAX_BACKGROUND_INTERVAL_MS),
                );
                continue;
            }
            Ok(Control::SetHistoryDir(path)) => {
                // Same directory: keep the open day file. A new one replaces
                // the recorder, closing whatever the old one had open.
                if history.as_ref().map(|target| &target.dir) != path.as_ref() {
                    history = path.map(HistoryTarget::new);
                }
                continue;
            }
            Ok(Control::ClearHistory(path, reply)) => {
                // Going through the recorder closes its open day file first;
                // otherwise the command layer's own thread removes the files.
                let result = match &mut history {
                    Some(target) if target.dir == path => target.recorder.clear(),
                    _ => history::clear(&path),
                };
                let _ = reply.send(result);
                continue;
            }
            Ok(Control::Stop) => Signal::Stop,
        };

        match next_action(signal, subscriber.is_some(), background) {
            Action::Sample => {}
            Action::Wait => continue,
            Action::Exit => break,
        }

        let period = if subscriber.is_some() {
            interval
        } else {
            background_interval
        };
        let mut snapshot = collector.sample();
        network.enrich(&mut snapshot, period);
        disk.enrich(&mut snapshot, period);
        if let Some(reason) = disk.new_failure() {
            eprintln!("[argus] disk enrichment unavailable: {reason}");
        }
        if let Some(target) = &mut history {
            target.recorder.record(&snapshot);
        }

        // A failed send means the page went away. Keep the thread when
        // background monitoring is on; otherwise stop and let the next start
        // spawn a fresh one.
        let disconnected = match subscriber.as_ref() {
            Some(channel) => channel.send(snapshot).is_err(),
            None => false,
        };
        if disconnected {
            eprintln!("[argus] sampler subscriber disconnected");
            subscriber = None;
            if next_action(Signal::Unsubscribe, false, background) == Action::Exit {
                break;
            }
        }
    }

    // Close the control channel first: a send from the host now fails at once,
    // so it replaces this handle instead of queueing controls this thread will
    // never read.
    drop(rx);
    // The page is gone; release the trace session so a remount can start it
    // again instead of inheriting a stale one.
    argus_core::net_process::stop_session(NETWORK_SESSION);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(value: u64) -> Duration {
        Duration::from_millis(value)
    }

    #[test]
    fn a_subscriber_samples_at_the_foreground_interval() {
        assert_eq!(wait_mode(true, false), WaitMode::Foreground);
        assert_eq!(
            timeout_for(WaitMode::Foreground, ms(500), ms(5_000)),
            Some(ms(500))
        );
        assert_eq!(next_action(Signal::Demand, true, false), Action::Sample);
        assert_eq!(next_action(Signal::Timeout, true, false), Action::Sample);
    }

    #[test]
    fn background_keeps_sampling_without_a_subscriber() {
        assert_eq!(wait_mode(false, true), WaitMode::Background);
        assert_eq!(
            timeout_for(WaitMode::Background, ms(500), ms(5_000)),
            Some(ms(5_000))
        );
        assert_eq!(next_action(Signal::Timeout, false, true), Action::Sample);
        // Dropping the page's subscription does not stop the thread.
        assert_eq!(next_action(Signal::Unsubscribe, false, true), Action::Wait);
    }

    #[test]
    fn no_subscriber_and_no_background_blocks_instead_of_sampling() {
        assert_eq!(wait_mode(false, false), WaitMode::Idle);
        assert_eq!(timeout_for(WaitMode::Idle, ms(500), ms(5_000)), None);
        // An idle thread never times out, but the pure decision stays safe.
        assert_eq!(next_action(Signal::Timeout, false, false), Action::Wait);
    }

    #[test]
    fn turning_background_off_without_a_subscriber_exits() {
        assert_eq!(
            next_action(Signal::BackgroundOff, false, false),
            Action::Exit
        );
        assert_eq!(
            next_action(Signal::BackgroundOff, true, false),
            Action::Wait
        );
        assert_eq!(next_action(Signal::Unsubscribe, false, false), Action::Exit);
        assert_eq!(next_action(Signal::Stop, true, true), Action::Exit);
    }
}

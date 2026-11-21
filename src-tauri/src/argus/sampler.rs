//! The snapshot sampling thread and its `Channel<Snapshot>` subscription.
//!
//! One thread serves the whole app. A page mounts, subscribes with a channel
//! and an interval, and receives a frame per tick; unmounting stops the thread,
//! so nothing samples while the page is away. The thread owns the collector and
//! the service clients, and never touches `ArgusState` or performs a service
//! round trip while a lock is held.

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use argus_core::meta::MetaStore;
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
}

impl Sampler {
    /// Starts the sampling thread. The collector is built there, so its setup
    /// overlaps the page's startup instead of delaying the command. `meta` is
    /// shared with the host, which serves the cached icons to the page.
    pub fn spawn(meta: Arc<MetaStore>) -> Self {
        let (tx, rx) = mpsc::channel::<Control>();
        std::thread::Builder::new()
            .name("wingharness-argus-sampler".into())
            .spawn(move || run(rx, meta))
            .expect("spawn the task manager sampler thread");
        Self { tx }
    }

    /// Sends a control message; `false` means the thread has already exited,
    /// so this handle can no longer deliver anything.
    pub fn send(&self, control: Control) -> bool {
        self.tx.send(control).is_ok()
    }
}

fn run(rx: Receiver<Control>, meta: Arc<MetaStore>) {
    let mut collector = Collector::new(meta);
    // Needs administrator rights; without them the network columns stay empty.
    collector.enable_process_network(NETWORK_SESSION);
    let mut network = NetworkClient::spawn();
    let mut disk = DiskClient::spawn();
    let mut subscriber: Option<Channel<Snapshot>> = None;
    let mut interval = Duration::from_millis(store::clamp_interval(
        argus_core::models::DEFAULT_INTERVAL_MS,
    ));
    let mut background = false;
    let mut background_interval =
        Duration::from_millis(argus_core::models::DEFAULT_BACKGROUND_INTERVAL_MS);
    let mut next_tick = Instant::now() + interval;

    loop {
        let waiting = subscriber.is_some() || background;
        let wait = next_tick.saturating_duration_since(Instant::now());
        let received = if waiting {
            rx.recv_timeout(wait)
        } else {
            // Nothing is listening and background monitoring is off: block
            // until the page subscribes or the app exits, instead of waking up
            // for frames nobody wants.
            rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
        };

        let sample_now = match received {
            Ok(Control::Subscribe(channel, interval_ms)) => {
                interval = Duration::from_millis(store::clamp_interval(interval_ms));
                subscriber = Some(channel);
                next_tick = Instant::now() + interval;
                true
            }
            Ok(Control::SetInterval(interval_ms)) => {
                interval = Duration::from_millis(store::clamp_interval(interval_ms));
                next_tick = Instant::now() + interval;
                continue;
            }
            Ok(Control::Refresh) => subscriber.is_some(),
            Ok(Control::Unsubscribe) => {
                subscriber = None;
                if !background {
                    break;
                }
                next_tick = Instant::now() + background_interval;
                continue;
            }
            Ok(Control::SetBackground(on)) => {
                background = on;
                if on {
                    next_tick = Instant::now() + background_interval;
                } else if subscriber.is_none() {
                    break;
                }
                continue;
            }
            Ok(Control::SetBackgroundInterval(ms)) => {
                background_interval = Duration::from_millis(ms.clamp(
                    argus_core::models::MIN_BACKGROUND_INTERVAL_MS,
                    argus_core::models::MAX_BACKGROUND_INTERVAL_MS,
                ));
                next_tick = Instant::now()
                    + if subscriber.is_some() {
                        interval
                    } else {
                        background_interval
                    };
                continue;
            }
            // The history recorder is attached by the background-lifetime port.
            Ok(Control::SetHistoryDir(path)) => {
                let _ = path;
                continue;
            }
            Ok(Control::ClearHistory(path, reply)) => {
                let _ = reply.send(argus_core::history::clear(&path));
                continue;
            }
            Ok(Control::Stop) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => subscriber.is_some(),
        };

        let Some(channel) = subscriber.as_ref() else {
            // A background tick with no subscriber has no channel to deliver
            // to; the history recorder will be fed here once it is attached.
            next_tick = Instant::now() + background_interval;
            continue;
        };

        let mut snapshot = collector.sample();
        network.enrich(&mut snapshot, interval);
        disk.enrich(&mut snapshot, interval);
        if let Some(reason) = disk.new_failure() {
            eprintln!("[argus] disk enrichment unavailable: {reason}");
        }

        // A failed send means the page went away. Keep the thread when
        // background monitoring is on; otherwise stop and let the next start
        // spawn a fresh one.
        if channel.send(snapshot).is_err() {
            eprintln!("[argus] sampler subscriber disconnected");
            subscriber = None;
            if !background {
                break;
            }
            next_tick = Instant::now() + background_interval;
            continue;
        }

        next_tick = if sample_now {
            Instant::now() + interval
        } else {
            let now = Instant::now();
            let next = next_tick + interval;
            // A long tick (a sleeping machine, say) skips instead of bursting.
            if next <= now { now + interval } else { next }
        };
    }

    // The page is gone; release the trace session so a remount can start it
    // again instead of inheriting a stale one.
    argus_core::net_process::stop_session(NETWORK_SESSION);
}

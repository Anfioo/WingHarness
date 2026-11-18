// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See UPSTREAM.md for the porting record.

//! Host-side network worker. Sampling only hands off a request and reads the
//! completed frame; it never waits for a service round trip.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use argus_core::Snapshot;
use argus_core::process::ProcessRow;

use crate::{NetworkFrame, Operation, Reply};

const TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Default)]
struct CachedNetwork {
    frame: Option<Arc<NetworkFrame>>,
    received: Option<Instant>,
}

#[derive(Default)]
struct Rates {
    previous: Option<Arc<NetworkFrame>>,
    identities: HashMap<u32, i64>,
    values: HashMap<u32, (i64, u64, u64)>,
}

impl Rates {
    fn apply(&mut self, frame: Arc<NetworkFrame>, processes: &mut [ProcessRow]) {
        let same_epoch = self
            .previous
            .as_ref()
            .filter(|p| p.epoch == frame.epoch && p.elapsed_us <= frame.elapsed_us);
        let new_frame = same_epoch.is_none_or(|p| p.elapsed_us != frame.elapsed_us);
        if same_epoch.is_none() {
            self.values.clear();
        }
        if let Some(previous) = same_epoch
            && previous.elapsed_us < frame.elapsed_us
        {
            let old: HashMap<_, _> = previous
                .counters
                .iter()
                .map(|&(pid, generation, _, sent, received)| (pid, (generation, sent, received)))
                .collect();
            let current: HashMap<_, _> = processes.iter().map(|p| (p.pid, p.create_time)).collect();
            let elapsed = frame.elapsed_us - previous.elapsed_us;
            self.values.clear();
            for &(pid, generation, first_us, sent, received) in &frame.counters {
                let Some(&created) = current
                    .get(&pid)
                    .filter(|&&c| self.identities.get(&pid) == Some(&c))
                else {
                    continue;
                };
                let baseline = match old.get(&pid) {
                    Some(&(g, s, r)) if g == generation => Some((s, r)),
                    _ if first_us > previous.elapsed_us => Some((0, 0)),
                    _ => None,
                };
                let Some((s, r)) = baseline else {
                    continue;
                };
                let (Some(sent), Some(received)) = (sent.checked_sub(s), received.checked_sub(r))
                else {
                    continue;
                };
                let rate = |bytes: u64| {
                    ((u128::from(bytes) * 1_000_000) / u128::from(elapsed)).min(u64::MAX as u128)
                        as u64
                };
                self.values
                    .insert(pid, (created, rate(sent), rate(received)));
            }
        }
        for p in processes.iter_mut() {
            p.net_sent = 0;
            p.net_received = 0;
            if let Some(&(created, sent, received)) = self.values.get(&p.pid)
                && created == p.create_time
            {
                p.net_sent = sent;
                p.net_received = received;
            }
        }
        if new_frame {
            self.identities = processes.iter().map(|p| (p.pid, p.create_time)).collect();
        }
        self.previous = Some(frame);
    }
}

pub struct NetworkClient {
    tx: Option<mpsc::SyncSender<()>>,
    cache: Arc<Mutex<CachedNetwork>>,
    thread: Option<JoinHandle<()>>,
    rates: Rates,
    last_cache: CachedNetwork,
}

impl NetworkClient {
    pub fn spawn() -> Self {
        let mut diagnostics = crate::diagnostics::Probe::default();
        Self::with_reader(move || {
            let pid = crate::util::stage("network service lookup", crate::install::running_pid())
                .ok()??;
            match crate::util::stage(
                "network snapshot request",
                crate::pipe::request_with_timeout(
                    crate::PIPE_NAME,
                    pid,
                    Operation::NetworkSnapshot,
                    TIMEOUT,
                ),
            )
            .ok()?
            {
                Reply::Network(frame) => {
                    if frame.is_none() {
                        diagnostics.collect(pid);
                    }
                    frame
                }
                _ => {
                    argus_core::diagnostics::warn(
                        "network snapshot request",
                        "unexpected reply type",
                    );
                    None
                }
            }
        })
    }

    fn with_reader(mut read: impl FnMut() -> Option<NetworkFrame> + Send + 'static) -> Self {
        let (tx, rx) = mpsc::sync_channel(1);
        let cache: Arc<Mutex<CachedNetwork>> = Arc::default();
        let shared = cache.clone();
        let thread = std::thread::Builder::new()
            .name("wingharness-network-client".into())
            .spawn(move || {
                while rx.recv().is_ok() {
                    let frame = read().map(Arc::new);
                    *shared.lock().unwrap() = CachedNetwork {
                        frame,
                        received: Some(Instant::now()),
                    };
                }
            })
            .expect("spawn service network client");
        Self {
            tx: Some(tx),
            cache,
            thread: Some(thread),
            rates: Rates::default(),
            last_cache: CachedNetwork::default(),
        }
    }

    /// Called only by the sampler; this never performs IPC or waits for it.
    pub fn enrich(&mut self, snapshot: &mut Snapshot, interval: Duration) {
        if snapshot.process_network {
            self.rates = Rates::default();
            return;
        }
        if let Some(tx) = &self.tx {
            let _ = tx.try_send(());
        }
        if let Ok(cache) = self.cache.try_lock() {
            self.last_cache = cache.clone();
        }
        let frame = self
            .last_cache
            .received
            .filter(|t| t.elapsed() <= interval * 2 + TIMEOUT)
            .and(self.last_cache.frame.clone());
        if let Some(frame) = frame {
            self.rates.apply(frame, &mut snapshot.processes);
            snapshot.process_network = true;
        } else {
            self.rates = Rates::default();
        }
    }
}

impl Drop for NetworkClient {
    fn drop(&mut self) {
        self.tx = None;
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn process(pid: u32, created: i64) -> ProcessRow {
        ProcessRow {
            pid,
            ppid: 0,
            create_time: created,
            name: "example.exe".into(),
            path: None,
            description: None,
            company: None,
            icon: None,
            web_view: None,
            windows_process: false,
            cpu: 0.0,
            cpu_time: 0,
            private_ws: 0,
            working_set: 0,
            commit: 0,
            io_read: 0,
            io_write: 0,
            io_other: 0,
            disk_read: None,
            disk_write: None,
            gpu: 0.0,
            gpu_engine: None,
            gpu_engines: Vec::new(),
            gpu_dedicated: 0,
            gpu_shared: 0,
            net_sent: 0,
            net_received: 0,
            threads: 1,
            handles: 1,
            session_id: 1,
            base_priority: 8,
            suspended: false,
            efficiency: false,
            app_window: false,
        }
    }

    fn frame(epoch: &str, seconds: u64, bytes: u64) -> Arc<NetworkFrame> {
        Arc::new(NetworkFrame {
            epoch: epoch.into(),
            elapsed_us: seconds * 1_000_000,
            counters: vec![(42, 1, 1, bytes, bytes * 2)],
        })
    }

    fn wait_for(mut condition: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(Instant::now() < deadline, "worker did not finish");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn rates_use_source_time_and_prime_after_restarts_or_pid_reuse() {
        let mut rates = Rates::default();
        let mut processes = vec![process(42, 10)];
        rates.apply(frame("a", 1, 5000), &mut processes);
        assert_eq!(processes[0].net_sent, 0);
        rates.apply(frame("a", 2, 6000), &mut processes);
        assert_eq!(
            (processes[0].net_sent, processes[0].net_received),
            (1000, 2000)
        );
        // A fast UI refresh must neither count the same bytes twice nor flash 0.
        rates.apply(frame("a", 2, 6000), &mut processes);
        assert_eq!(processes[0].net_sent, 1000);
        // Hidden windows sample every five seconds.
        rates.apply(frame("a", 7, 11000), &mut processes);
        assert_eq!(processes[0].net_sent, 1000);
        processes[0].create_time = 20;
        rates.apply(frame("a", 7, 11000), &mut processes);
        assert_eq!(processes[0].net_sent, 0);
        rates.apply(frame("a", 8, 90000), &mut processes);
        assert_eq!(processes[0].net_sent, 0);
        rates.apply(frame("a", 9, 91000), &mut processes);
        assert_eq!(processes[0].net_sent, 1000);
        rates.apply(frame("b", 1, 900000), &mut processes);
        assert_eq!(processes[0].net_sent, 0);
        rates.apply(frame("b", 2, 901000), &mut processes);
        assert_eq!(processes[0].net_sent, 1000);
    }

    #[test]
    fn newly_active_process_counters_start_from_zero() {
        let mut rates = Rates::default();
        let mut processes = vec![process(42, 10)];
        rates.apply(
            Arc::new(NetworkFrame {
                epoch: "a".into(),
                elapsed_us: 1_000_000,
                counters: vec![],
            }),
            &mut processes,
        );
        rates.apply(
            Arc::new(NetworkFrame {
                epoch: "a".into(),
                elapsed_us: 2_000_000,
                counters: vec![(42, 1, 2_000_000, 1000, 2000)],
            }),
            &mut processes,
        );
        assert_eq!(
            (processes[0].net_sent, processes[0].net_received),
            (1000, 2000)
        );
    }

    fn snapshot() -> Snapshot {
        Snapshot {
            seq: 1,
            timestamp: 0,
            system: Default::default(),
            hardware: Default::default(),
            processes: vec![process(42, 10)],
            process_network: false,
        }
    }

    #[test]
    fn network_reads_do_not_block_sampling_and_stale_frames_are_hidden() {
        let (started, entered) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let mut gate = Some(gate);
        let available = Arc::new(AtomicBool::new(true));
        let flag = available.clone();
        let mut client = NetworkClient::with_reader(move || {
            if let Some(gate) = gate.take() {
                started.send(()).unwrap();
                gate.recv_timeout(Duration::from_secs(5)).unwrap();
            }
            flag.load(Ordering::Relaxed)
                .then(|| (*frame("a", 1, 5000)).clone())
        });
        client.enrich(&mut snapshot(), Duration::from_secs(1));
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        let start = Instant::now();
        for _ in 0..100 {
            client.enrich(&mut snapshot(), Duration::from_secs(1));
        }
        release.send(()).unwrap();
        assert!(start.elapsed() < Duration::from_secs(1));
        wait_for(|| client.cache.lock().unwrap().frame.is_some());
        let mut s = snapshot();
        client.enrich(&mut s, Duration::from_secs(1));
        assert!(s.process_network);
        available.store(false, Ordering::Relaxed);
        client.enrich(&mut snapshot(), Duration::from_secs(1));
        wait_for(|| client.cache.lock().unwrap().frame.is_none());
        // A concurrent cache write may make try_lock retain the previous frame
        // for one sample. Wait for the sampler to observe the completed read.
        wait_for(|| {
            let mut s = snapshot();
            client.enrich(&mut s, Duration::from_secs(1));
            !s.process_network
        });
        // A wedged server also expires without waiting for its I/O timeout.
        let stale = CachedNetwork {
            frame: Some(frame("a", 1, 50)),
            received: Some(Instant::now() - Duration::from_secs(20)),
        };
        client.last_cache = stale.clone();
        let cache = client.cache.clone();
        let mut guard = cache.lock().unwrap();
        *guard = stale;
        let mut s = snapshot();
        client.enrich(&mut s, Duration::from_secs(5));
        assert!(!s.process_network);
        drop(guard);
    }
}

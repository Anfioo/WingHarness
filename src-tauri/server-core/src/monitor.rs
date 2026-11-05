//! Live server metrics: one sampled exec channel per connected profile.
//!
//! The sampler reuses the profile's established SSH connection, opens a short
//! exec channel once per second, and parses a fixed shell script. Nothing here
//! accepts user input: the script is a constant.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::events::{self, MetricsEvent, SERVER_METRICS};
use crate::models::{
    CpuMetrics, DiskMetrics, LoadMetrics, MemoryMetrics, MetricsSample, NetworkMetrics,
};
use crate::ssh::Connection;
use crate::store::unix_now;

/// One sample per second.
const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
/// A slow remote command must not stall the sampler.
const EXEC_TIMEOUT: Duration = Duration::from_secs(3);
/// Roughly five minutes of history at one sample per second.
const HISTORY_CAPACITY: usize = 300;
const MAX_CONSECUTIVE_FAILURES: u32 = 3;

/// Fixed probe. Every line is an independent POSIX sh command; no bash syntax
/// and no interpolation, so nothing user-supplied can reach the remote shell.
pub(crate) const METRICS_SCRIPT: &str = "\
echo '@@stat'; LC_ALL=C cat /proc/stat 2>/dev/null
echo '@@mem'; LC_ALL=C cat /proc/meminfo 2>/dev/null
echo '@@net'; LC_ALL=C cat /proc/net/dev 2>/dev/null
echo '@@disk'; LC_ALL=C cat /proc/diskstats 2>/dev/null
echo '@@load'; LC_ALL=C cat /proc/loadavg 2>/dev/null
echo '@@uptime'; LC_ALL=C cat /proc/uptime 2>/dev/null
echo '@@df'; LC_ALL=C df -kP / 2>/dev/null
echo '@@dfi'; LC_ALL=C df -iP / 2>/dev/null
echo '@@ps'; LC_ALL=C ps -e --no-headers 2>/dev/null | wc -l
echo '@@thr'; LC_ALL=C ps -eLf --no-headers 2>/dev/null | wc -l
";

/// Everything one script run reported, with the CPU fields already aggregated
/// into the groups the sample needs.
#[derive(Debug, Clone, PartialEq)]
struct Parsed {
    cpu_total: u64,
    /// idle + iowait.
    cpu_idle: u64,
    /// user + nice.
    cpu_user: u64,
    /// system + irq + softirq.
    cpu_system: u64,
    cpu_iowait: u64,
    cpu_steal: u64,

    mem_total: u64,
    mem_used: u64,
    mem_available: u64,
    swap_total: u64,
    swap_used: u64,

    net_rx: u64,
    net_tx: u64,

    disk_read_sectors: u64,
    disk_write_sectors: u64,
    disk_total: u64,
    disk_used: u64,
    disk_percent: f64,
    disk_inode_percent: f64,

    load_one: f64,
    load_five: f64,
    load_fifteen: f64,
    uptime_secs: u64,
    processes: u32,
    threads: u32,
}

/// Cumulative counters of one sample plus the instant they were read, so the
/// next sample can turn deltas into per-second rates.
#[derive(Debug, Clone)]
pub(crate) struct RawCounters {
    cpu_total: u64,
    cpu_idle: u64,
    cpu_user: u64,
    cpu_system: u64,
    cpu_iowait: u64,
    cpu_steal: u64,
    net_rx: u64,
    net_tx: u64,
    disk_read_sectors: u64,
    disk_write_sectors: u64,
    instant: Instant,
}

impl RawCounters {
    fn new(parsed: &Parsed, instant: Instant) -> Self {
        Self {
            cpu_total: parsed.cpu_total,
            cpu_idle: parsed.cpu_idle,
            cpu_user: parsed.cpu_user,
            cpu_system: parsed.cpu_system,
            cpu_iowait: parsed.cpu_iowait,
            cpu_steal: parsed.cpu_steal,
            net_rx: parsed.net_rx,
            net_tx: parsed.net_tx,
            disk_read_sectors: parsed.disk_read_sectors,
            disk_write_sectors: parsed.disk_write_sectors,
            instant,
        }
    }
}

/// The background sampler of one profile and the history it fills.
pub(crate) struct MetricsHandle {
    pub(crate) task: tauri::async_runtime::JoinHandle<()>,
    pub(crate) samples: Arc<Mutex<VecDeque<MetricsSample>>>,
}

/// Split the script output into `@@marker` sections; the marker line itself is
/// dropped and every following line belongs to that section.
fn split_sections(output: &str) -> HashMap<String, String> {
    let mut sections: HashMap<String, String> = HashMap::new();
    let mut current: Option<String> = None;

    for line in output.lines() {
        let trimmed = line.trim();
        if let Some(name) = trimmed.strip_prefix("@@") {
            let name = name.trim().to_string();
            sections.entry(name.clone()).or_default();
            current = Some(name);
        } else if let Some(name) = current.as_ref() {
            if let Some(section) = sections.get_mut(name) {
                section.push_str(line);
                section.push('\n');
            }
        }
    }

    sections
}

fn section<'a>(sections: &'a HashMap<String, String>, name: &str) -> &'a str {
    sections.get(name).map(String::as_str).unwrap_or("")
}

/// Parse one script run. Only `/proc/stat` and `/proc/meminfo` are mandatory:
/// a host without them is not Linux, which the UI reports as "waiting".
fn parse(output: &str) -> Result<Parsed, String> {
    let sections = split_sections(output);

    let cpu = parse_cpu(section(&sections, "stat"))?;
    let memory = parse_meminfo(section(&sections, "mem"))?;
    let (net_rx, net_tx) = parse_net(section(&sections, "net"));
    let (disk_read_sectors, disk_write_sectors) = parse_diskstats(section(&sections, "disk"));
    let (load_one, load_five, load_fifteen) = parse_loadavg(section(&sections, "load"));
    let uptime_secs = parse_uptime(section(&sections, "uptime"));
    let (disk_total, disk_used, disk_percent) = parse_df(section(&sections, "df"));
    let disk_inode_percent = parse_df_inodes(section(&sections, "dfi"));
    let processes = parse_count(section(&sections, "ps"));
    let threads = parse_count(section(&sections, "thr"));

    Ok(Parsed {
        cpu_total: cpu.total,
        cpu_idle: cpu.idle,
        cpu_user: cpu.user,
        cpu_system: cpu.system,
        cpu_iowait: cpu.iowait,
        cpu_steal: cpu.steal,
        mem_total: memory.total,
        mem_used: memory.used,
        mem_available: memory.available,
        swap_total: memory.swap_total,
        swap_used: memory.swap_used,
        net_rx,
        net_tx,
        disk_read_sectors,
        disk_write_sectors,
        disk_total,
        disk_used,
        disk_percent,
        disk_inode_percent,
        load_one,
        load_five,
        load_fifteen,
        uptime_secs,
        processes,
        threads,
    })
}

struct CpuCounters {
    total: u64,
    idle: u64,
    user: u64,
    system: u64,
    iowait: u64,
    steal: u64,
}

fn parse_cpu(stat: &str) -> Result<CpuCounters, String> {
    let line = stat
        .lines()
        .find(|line| line.starts_with("cpu "))
        .ok_or_else(|| "missing aggregate cpu line".to_string())?;

    let mut fields = line.split_whitespace();
    let _label = fields.next();

    let mut values = [0u64; 8];
    for value in values.iter_mut() {
        let field = fields
            .next()
            .ok_or_else(|| "truncated cpu line".to_string())?;
        *value = field
            .parse()
            .map_err(|_| "invalid cpu counter".to_string())?;
    }

    let [user, nice, system, idle, iowait, irq, softirq, steal] = values;
    Ok(CpuCounters {
        total: values.iter().copied().sum(),
        idle: idle + iowait,
        user: user + nice,
        system: system + irq + softirq,
        iowait,
        steal,
    })
}

struct MemoryValues {
    total: u64,
    used: u64,
    available: u64,
    swap_total: u64,
    swap_used: u64,
}

fn parse_meminfo(meminfo: &str) -> Result<MemoryValues, String> {
    let mut total = 0u64;
    let mut available: Option<u64> = None;
    let mut free = 0u64;
    let mut swap_total = 0u64;
    let mut swap_free = 0u64;

    for line in meminfo.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let Some(value) = rest.split_whitespace().next() else {
            continue;
        };
        let Ok(kilobytes) = value.parse::<u64>() else {
            continue;
        };
        let bytes = kilobytes.saturating_mul(1024);

        match key.trim() {
            "MemTotal" => total = bytes,
            "MemAvailable" => available = Some(bytes),
            "MemFree" => free = bytes,
            "SwapTotal" => swap_total = bytes,
            "SwapFree" => swap_free = bytes,
            _ => {}
        }
    }

    if total == 0 {
        return Err("missing MemTotal".to_string());
    }

    let available = available.unwrap_or(free);
    Ok(MemoryValues {
        total,
        used: total.saturating_sub(available),
        available,
        swap_total,
        swap_used: swap_total.saturating_sub(swap_free),
    })
}

fn parse_net(net: &str) -> (u64, u64) {
    let mut rx = 0u64;
    let mut tx = 0u64;

    for line in net.lines() {
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        if name.trim() == "lo" {
            continue;
        }
        let fields: Vec<&str> = rest.split_whitespace().collect();
        if fields.len() < 9 {
            continue;
        }
        rx = rx.saturating_add(fields[0].parse().unwrap_or(0));
        tx = tx.saturating_add(fields[8].parse().unwrap_or(0));
    }

    (rx, tx)
}

/// Whether a `/proc/diskstats` name is a whole disk rather than a partition or
/// a virtual device. Counting partitions would double-count the same sectors.
fn is_whole_disk(name: &str) -> bool {
    if let Some(rest) = name.strip_prefix("nvme") {
        return match rest.split_once('n') {
            Some((controller, namespace)) => {
                !controller.is_empty()
                    && !namespace.is_empty()
                    && controller.chars().all(|c| c.is_ascii_digit())
                    && namespace.chars().all(|c| c.is_ascii_digit())
            }
            None => false,
        };
    }

    if let Some(rest) = name.strip_prefix("mmcblk") {
        return !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit());
    }

    for prefix in ["sd", "vd", "xvd"] {
        if let Some(rest) = name.strip_prefix(prefix) {
            return !rest.is_empty() && rest.chars().all(|c| c.is_ascii_lowercase());
        }
    }

    false
}

fn parse_diskstats(diskstats: &str) -> (u64, u64) {
    let mut read_sectors = 0u64;
    let mut write_sectors = 0u64;

    for line in diskstats.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 10 {
            continue;
        }
        if !is_whole_disk(fields[2]) {
            continue;
        }
        read_sectors = read_sectors.saturating_add(fields[5].parse().unwrap_or(0));
        write_sectors = write_sectors.saturating_add(fields[9].parse().unwrap_or(0));
    }

    (read_sectors, write_sectors)
}

fn parse_loadavg(loadavg: &str) -> (f64, f64, f64) {
    let values: Vec<f64> = loadavg
        .split_whitespace()
        .take(3)
        .filter_map(|field| field.parse().ok())
        .collect();

    (
        values.first().copied().unwrap_or(0.0),
        values.get(1).copied().unwrap_or(0.0),
        values.get(2).copied().unwrap_or(0.0),
    )
}

fn parse_uptime(uptime: &str) -> u64 {
    uptime
        .split_whitespace()
        .next()
        .and_then(|field| field.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value as u64)
        .unwrap_or(0)
}

fn parse_percent(field: &str) -> f64 {
    field
        .trim()
        .trim_end_matches('%')
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}

/// `df -kP /`: blocks are 1024-byte units.
fn parse_df(df: &str) -> (u64, u64, f64) {
    let Some(line) = df.lines().nth(1) else {
        return (0, 0, 0.0);
    };
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 6 {
        return (0, 0, 0.0);
    }

    let total = fields[1]
        .parse::<u64>()
        .unwrap_or(0)
        .saturating_mul(1024);
    let used = fields[2]
        .parse::<u64>()
        .unwrap_or(0)
        .saturating_mul(1024);
    (total, used, parse_percent(fields[4]))
}

fn parse_df_inodes(df_inodes: &str) -> f64 {
    let Some(line) = df_inodes.lines().nth(1) else {
        return 0.0;
    };
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 6 {
        return 0.0;
    }
    parse_percent(fields[4])
}

fn parse_count(value: &str) -> u32 {
    value
        .trim()
        .parse::<u32>()
        .unwrap_or(0)
}

fn ratio(delta: u64, total: f64) -> f64 {
    if total > 0.0 {
        delta as f64 / total * 100.0
    } else {
        0.0
    }
}

fn rate(delta: u64, elapsed_secs: f64) -> f64 {
    if elapsed_secs > 0.0 {
        delta as f64 / elapsed_secs
    } else {
        0.0
    }
}

fn build_sample(
    current: &Parsed,
    previous: Option<&RawCounters>,
    latency_ms: f64,
    at: i64,
) -> MetricsSample {
    let elapsed = previous
        .map(|counters| counters.instant.elapsed().as_secs_f64())
        .unwrap_or(0.0);
    build_sample_with_elapsed(current, previous, elapsed, latency_ms, at)
}

fn build_sample_with_elapsed(
    current: &Parsed,
    previous: Option<&RawCounters>,
    elapsed_secs: f64,
    latency_ms: f64,
    at: i64,
) -> MetricsSample {
    let (overall, user, system, iowait, steal) = match previous {
        Some(counters) => {
            let total = current.cpu_total.saturating_sub(counters.cpu_total) as f64;
            let busy = total - current.cpu_idle.saturating_sub(counters.cpu_idle) as f64;
            (
                ratio(busy.max(0.0) as u64, total),
                ratio(current.cpu_user.saturating_sub(counters.cpu_user), total),
                ratio(
                    current.cpu_system.saturating_sub(counters.cpu_system),
                    total,
                ),
                ratio(
                    current.cpu_iowait.saturating_sub(counters.cpu_iowait),
                    total,
                ),
                ratio(
                    current.cpu_steal.saturating_sub(counters.cpu_steal),
                    total,
                ),
            )
        }
        None => (0.0, 0.0, 0.0, 0.0, 0.0),
    };

    let (net_rx, net_tx) = match previous {
        Some(counters) => (
            rate(current.net_rx.saturating_sub(counters.net_rx), elapsed_secs),
            rate(current.net_tx.saturating_sub(counters.net_tx), elapsed_secs),
        ),
        None => (0.0, 0.0),
    };

    let (disk_read, disk_write) = match previous {
        Some(counters) => (
            rate(
                current
                    .disk_read_sectors
                    .saturating_sub(counters.disk_read_sectors)
                    .saturating_mul(512),
                elapsed_secs,
            ),
            rate(
                current
                    .disk_write_sectors
                    .saturating_sub(counters.disk_write_sectors)
                    .saturating_mul(512),
                elapsed_secs,
            ),
        ),
        None => (0.0, 0.0),
    };

    let memory_percent = ratio(current.mem_used, current.mem_total as f64);

    MetricsSample {
        at,
        latency_ms,
        cpu: CpuMetrics {
            overall,
            user,
            system,
            iowait,
            steal,
        },
        memory: MemoryMetrics {
            total: current.mem_total,
            used: current.mem_used,
            available: current.mem_available,
            percent: memory_percent,
            swap_total: current.swap_total,
            swap_used: current.swap_used,
        },
        disk: DiskMetrics {
            total: current.disk_total,
            used: current.disk_used,
            percent: current.disk_percent,
            inode_percent: current.disk_inode_percent,
            read_bytes_per_sec: disk_read,
            write_bytes_per_sec: disk_write,
        },
        network: NetworkMetrics {
            rx_bytes_per_sec: net_rx,
            tx_bytes_per_sec: net_tx,
        },
        load: LoadMetrics {
            one: current.load_one,
            five: current.load_five,
            fifteen: current.load_fifteen,
        },
        uptime_secs: current.uptime_secs,
        processes: current.processes,
        threads: current.threads,
    }
}

fn push_sample(buffer: &Mutex<VecDeque<MetricsSample>>, sample: &MetricsSample) {
    let Ok(mut samples) = buffer.lock() else {
        return;
    };
    if samples.len() >= HISTORY_CAPACITY {
        samples.pop_front();
    }
    samples.push_back(sample.clone());
}

/// Start the sampler for one profile. Returns immediately; the task stops on
/// drop of its handle, on three consecutive failures, or on abort.
pub(crate) fn spawn_sampler(
    app: Option<tauri::AppHandle>,
    profile_id: String,
    connection: Arc<Connection>,
) -> MetricsHandle {
    let samples: Arc<Mutex<VecDeque<MetricsSample>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(HISTORY_CAPACITY)));
    let buffer = samples.clone();
    let task_profile = profile_id.clone();

    let task = tauri::async_runtime::spawn(async move {
        log::info!("server_metrics_started profile={task_profile}");

        let mut ticker = tokio::time::interval(SAMPLE_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut previous: Option<RawCounters> = None;
        let mut failures: u32 = 0;

        loop {
            ticker.tick().await;

            let started = Instant::now();
            let output = match connection.exec(METRICS_SCRIPT, EXEC_TIMEOUT).await {
                Ok(output) => Ok(output),
                Err(error) => Err(error.message),
            };
            let latency_ms = started.elapsed().as_secs_f64() * 1000.0;

            let parsed = match output.and_then(|output| parse(&output)) {
                Ok(parsed) => parsed,
                Err(message) => {
                    failures += 1;
                    log::warn!(
                        "server_metrics_sample_failed profile={task_profile} attempt={failures} error={message}"
                    );
                    if failures >= MAX_CONSECUTIVE_FAILURES {
                        break;
                    }
                    continue;
                }
            };

            failures = 0;
            let instant = Instant::now();
            let sample = build_sample(&parsed, previous.as_ref(), latency_ms, unix_now());
            previous = Some(RawCounters::new(&parsed, instant));

            push_sample(&buffer, &sample);

            if let Some(app) = app.as_ref() {
                events::emit(
                    app,
                    SERVER_METRICS,
                    MetricsEvent {
                        profile_id: task_profile.clone(),
                        sample,
                    },
                );
            }
        }

        log::info!("server_metrics_stopped profile={task_profile}");
    });

    MetricsHandle { task, samples }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    const AT: i64 = 1_700_000_000;

    fn script_output(stat: &str, mem: &str, net: &str, disk: &str) -> String {
        format!(
            "@@stat\n{stat}\n@@mem\n{mem}\n@@net\n{net}\n@@disk\n{disk}\n\
             @@load\n0.50 0.40 0.30 1/100 1234\n@@uptime\n86412.53 700000.00\n\
             @@df\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 104857600 52428800 52428800 50% /\n\
             @@dfi\nFilesystem Inodes IUsed IFree IUse% Mounted on\n/dev/sda1 6553600 327680 6225920 5% /\n\
             @@ps\n42\n@@thr\n128\n"
        )
    }

    const STAT_A: &str = "cpu  1000 100 500 8000 200 0 0 0 0 0\ncpu0 1 1 1 1 1 1 1 1 0 0";
    const STAT_B: &str = "cpu  1100 120 550 8500 260 0 0 20 0 0\ncpu0 1 1 1 1 1 1 1 1 0 0";

    const MEM: &str = "MemTotal:        2048000 kB\nMemFree:          100000 kB\nMemAvailable:     512000 kB\nSwapTotal:       1024000 kB\nSwapFree:         512000 kB";

    const NET: &str = "Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    lo: 999999 10 0 0 0 0 0 0 999999 10 0 0 0 0 0 0\n  eth0: 1000 10 0 0 0 0 0 0 2000 10 0 0 0 0 0 0\n  eth1: 500 5 0 0 0 0 0 0 700 5 0 0 0 0 0 0";

    const DISK: &str = "\
   8       0 sda 100 0 1000 0 200 0 2000 0 0 0 0 0 0 0 0 0
   8       1 sda1 100 0 900 0 200 0 1900 0 0 0 0 0 0 0 0 0
 259       0 nvme0n1 100 0 500 0 200 0 500 0 0 0 0 0 0 0 0 0
 259       1 nvme0n1p1 100 0 400 0 200 0 400 0 0 0 0 0 0 0 0 0
 179       0 mmcblk0 100 0 300 0 200 0 300 0 0 0 0 0 0 0 0 0
 179       1 mmcblk0p1 100 0 200 0 200 0 200 0 0 0 0 0 0 0 0 0
   7       0 loop0 10 0 99999 0 10 0 99999 0 0 0 0 0 0 0 0 0";

    #[test]
    fn parses_cpu_and_computes_deltas() {
        let first = parse(&script_output(STAT_A, MEM, NET, DISK)).expect("first sample parses");
        let second = parse(&script_output(STAT_B, MEM, NET, DISK)).expect("second sample parses");

        let previous = RawCounters::new(&first, Instant::now());
        let sample = build_sample_with_elapsed(&second, Some(&previous), 1.0, 12.5, AT);

        assert!((sample.cpu.overall - 190.0 / 750.0 * 100.0).abs() < 1e-9);
        assert!((sample.cpu.user - 120.0 / 750.0 * 100.0).abs() < 1e-9);
        assert!((sample.cpu.system - 50.0 / 750.0 * 100.0).abs() < 1e-9);
        assert!((sample.cpu.iowait - 60.0 / 750.0 * 100.0).abs() < 1e-9);
        assert!((sample.cpu.steal - 20.0 / 750.0 * 100.0).abs() < 1e-9);
        assert_eq!(sample.latency_ms, 12.5);
        assert_eq!(sample.at, AT);
    }

    #[test]
    fn parses_memory_and_handles_zero_swap() {
        let parsed = parse(&script_output(STAT_A, MEM, NET, DISK)).expect("parses");

        assert_eq!(parsed.mem_total, 2048000 * 1024);
        assert_eq!(parsed.mem_available, 512000 * 1024);
        assert_eq!(parsed.mem_used, (2048000 - 512000) * 1024);
        assert_eq!(parsed.swap_total, 1024000 * 1024);
        assert_eq!(parsed.swap_used, 512000 * 1024);

        let no_swap = "MemTotal: 1024 kB\nMemAvailable: 256 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB";
        let parsed = parse(&script_output(STAT_A, no_swap, NET, DISK)).expect("parses");
        assert_eq!(parsed.swap_total, 0);
        assert_eq!(parsed.swap_used, 0);

        let sample = build_sample(&parsed, None, 1.0, AT);
        assert!((sample.memory.percent - 75.0).abs() < 1e-9);
        assert_eq!(sample.memory.swap_total, 0);
    }

    #[test]
    fn parses_network_and_skips_loopback() {
        let parsed = parse(&script_output(STAT_A, MEM, NET, DISK)).expect("parses");
        assert_eq!(parsed.net_rx, 1500);
        assert_eq!(parsed.net_tx, 2700);
    }

    #[test]
    fn parses_diskstats_whole_disks_only() {
        assert!(is_whole_disk("sda"));
        assert!(is_whole_disk("vda"));
        assert!(is_whole_disk("xvda"));
        assert!(is_whole_disk("nvme0n1"));
        assert!(is_whole_disk("mmcblk0"));
        assert!(!is_whole_disk("sda1"));
        assert!(!is_whole_disk("nvme0n1p1"));
        assert!(!is_whole_disk("mmcblk0p1"));
        assert!(!is_whole_disk("loop0"));

        let parsed = parse(&script_output(STAT_A, MEM, NET, DISK)).expect("parses");
        assert_eq!(parsed.disk_read_sectors, 1000 + 500 + 300);
        assert_eq!(parsed.disk_write_sectors, 2000 + 500 + 300);
    }

    #[test]
    fn parses_df_and_inodes() {
        let parsed = parse(&script_output(STAT_A, MEM, NET, DISK)).expect("parses");
        assert_eq!(parsed.disk_total, 104857600 * 1024);
        assert_eq!(parsed.disk_used, 52428800 * 1024);
        assert_eq!(parsed.disk_percent, 50.0);
        assert_eq!(parsed.disk_inode_percent, 5.0);
    }

    #[test]
    fn parses_load_uptime_and_counts() {
        let parsed = parse(&script_output(STAT_A, MEM, NET, DISK)).expect("parses");
        assert_eq!(parsed.load_one, 0.5);
        assert_eq!(parsed.load_five, 0.4);
        assert_eq!(parsed.load_fifteen, 0.3);
        assert_eq!(parsed.uptime_secs, 86412);
        assert_eq!(parsed.processes, 42);
        assert_eq!(parsed.threads, 128);
    }

    #[test]
    fn first_sample_has_zero_cpu_and_rates() {
        let parsed = parse(&script_output(STAT_A, MEM, NET, DISK)).expect("parses");
        let sample = build_sample(&parsed, None, 3.0, AT);

        assert_eq!(sample.cpu.overall, 0.0);
        assert_eq!(sample.cpu.user, 0.0);
        assert_eq!(sample.cpu.system, 0.0);
        assert_eq!(sample.cpu.iowait, 0.0);
        assert_eq!(sample.cpu.steal, 0.0);
        assert_eq!(sample.network.rx_bytes_per_sec, 0.0);
        assert_eq!(sample.network.tx_bytes_per_sec, 0.0);
        assert_eq!(sample.disk.read_bytes_per_sec, 0.0);
        assert_eq!(sample.disk.write_bytes_per_sec, 0.0);
        assert_eq!(sample.memory.total, 2048000 * 1024);
    }

    #[test]
    fn deltas_turn_into_rates() {
        let first = parse(&script_output(STAT_A, MEM, NET, DISK)).expect("parses");
        let second = parse(&script_output(STAT_B, MEM, NET, DISK)).expect("parses");

        let previous = RawCounters::new(&first, Instant::now());
        let sample = build_sample_with_elapsed(&second, Some(&previous), 2.0, 1.0, AT);

        // Network counters are identical, so the rates collapse to zero.
        assert_eq!(sample.network.rx_bytes_per_sec, 0.0);
        assert_eq!(sample.disk.read_bytes_per_sec, 0.0);

        let mut bigger = second.clone();
        bigger.net_rx += 2048;
        bigger.net_tx += 1024;
        bigger.disk_read_sectors += 4;
        let sample = build_sample_with_elapsed(&bigger, Some(&previous), 2.0, 1.0, AT);

        assert_eq!(sample.network.rx_bytes_per_sec, 1024.0);
        assert_eq!(sample.network.tx_bytes_per_sec, 512.0);
        assert_eq!(sample.disk.read_bytes_per_sec, 4.0 * 512.0 / 2.0);
    }

    #[test]
    fn zero_elapsed_does_not_divide_by_zero() {
        let first = parse(&script_output(STAT_A, MEM, NET, DISK)).expect("parses");
        let previous = RawCounters::new(&first, Instant::now());
        let sample = build_sample_with_elapsed(&first, Some(&previous), 0.0, 1.0, AT);

        assert_eq!(sample.network.rx_bytes_per_sec, 0.0);
        assert_eq!(sample.disk.write_bytes_per_sec, 0.0);
    }

    #[test]
    fn missing_proc_stat_is_an_error() {
        let output = "@@stat\n@@mem\nMemTotal: 1024 kB\n";
        assert!(parse(output).is_err());
    }
}

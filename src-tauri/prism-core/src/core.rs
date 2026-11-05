//! Minimal mihomo core management.
//!
//! Three things only: probe the binary, run `-t` against a config, and start /
//! stop the process. Hot reload goes through mihomo's own REST controller, so
//! there is no second protocol to implement and no elevation or TUN handling —
//! the user's profile carries whatever those need.

use std::fs::OpenOptions;
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

use crate::settings;
use crate::store;

#[derive(Debug, Clone, Serialize)]
pub struct CoreProbe {
    pub found: bool,
    pub path: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub binary: CoreProbe,
    /// The controller address the compiled output names.
    pub api: Option<String>,
    /// Whether that address answers right now. `running` only says the child
    /// process exists: a core that lost its controller port keeps proxying with
    /// no REST API at all, and every request then reaches whichever other client
    /// owns the port.
    pub api_reachable: bool,
    pub api_error: Option<String>,
}

pub type CoreSlot = Arc<Mutex<Option<Child>>>;

pub fn probe() -> CoreProbe {
    let path = match store::core_binary() {
        Ok(path) => path,
        Err(_) => {
            return CoreProbe {
                found: false,
                path: String::new(),
                version: None,
            }
        }
    };
    let found = path.is_file();
    let version = if found { version_of(&path).ok() } else { None };
    CoreProbe {
        found,
        path: path.to_string_lossy().to_string(),
        version,
    }
}

fn version_of(binary: &Path) -> Result<String, String> {
    let mut command = Command::new(binary);
    let output = hidden(&mut command)
        .arg("-v")
        .output()
        .map_err(|e| format!("Failed to run mihomo -v: {e}"))?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let text = if text.is_empty() {
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    } else {
        text
    };
    if output.status.success() {
        Ok(text.lines().next().unwrap_or_default().to_string())
    } else {
        Err(text)
    }
}

/// Run `mihomo -t` against the given YAML. `Ok(false)` means the core rejected
/// it; `Err` means we could not run the check at all.
pub fn validate(yaml: &str) -> Result<(bool, String), String> {
    let binary = store::core_binary()?;
    if !binary.is_file() {
        return Err(format!("{} not found; place mihomo in the Clash directory", binary.display()));
    }
    let path = store::validation_path()?;
    store::atomic_write(&path, yaml)?;

    let mut command = Command::new(&binary);
    let output = hidden(&mut command)
        .arg("-t")
        // Same home directory the core itself runs with, so the check sees the
        // geo databases that are already there instead of downloading them.
        .arg("-d")
        .arg(store::root()?)
        .arg("-f")
        .arg(&path)
        .output()
        .map_err(|e| format!("Failed to run mihomo -t: {e}"))?;

    let mut text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    Ok((output.status.success(), text))
}

/// Whether a failed `mihomo -t` run says anything about the config itself.
///
/// The check initialises the geo databases before it looks at a single rule, so
/// on a machine that cannot reach the download host it fails over data the
/// config never asked for — while the core would still start and route, GEOIP
/// and GEOSITE rules merely logging an error. Only a failure that is not about
/// geo data means the config is actually wrong.
pub fn validation_blocks(output: &str) -> bool {
    const GEO: [&str; 3] = ["MMDB", "GeoIP", "GeoSite"];
    let problems: Vec<&str> = output
        .lines()
        .filter(|line| line.contains("level=error") || line.contains("level=fatal"))
        .collect();
    if problems.is_empty() {
        // The core failed without saying why; do not overrule it.
        return true;
    }
    problems
        .iter()
        .any(|line| !GEO.iter().any(|hint| line.contains(hint)))
}

/// What a rejected `mihomo -t` run complained about, for the message the UI
/// shows. The engine only reports that validation failed, so without this the
/// user is left guessing which rule or field the core objected to.
pub fn validation_reason(output: &str) -> String {
    let problems: Vec<&str> = output
        .lines()
        .filter(|line| line.contains("level=error") || line.contains("level=fatal"))
        .map(problem_text)
        .collect();
    if !problems.is_empty() {
        return problems.join("; ");
    }
    output
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
        .unwrap_or_else(|| "mihomo -t rejected the config".to_string())
}

/// Strip the log envelope `time="…" level=error msg="…"` down to the message:
/// the timestamp and level say nothing about why the config was rejected.
fn problem_text(line: &str) -> &str {
    let rest = line
        .strip_prefix("time=\"")
        .and_then(|rest| rest.split_once('"'))
        .map(|(_, tail)| tail.trim_start())
        .unwrap_or(line);
    rest.strip_prefix("level=")
        .and_then(|rest| rest.split_once("msg=\""))
        .map(|(_, tail)| tail.trim_end().trim_end_matches('"'))
        .unwrap_or(rest)
}

pub fn start(slot: &CoreSlot) -> Result<u32, String> {
    let mut guard = slot.lock().map_err(|_| "Core state lock is poisoned".to_string())?;

    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(None) => return Err("Core is already running".to_string()),
            _ => *guard = None,
        }
    }

    let binary = store::core_binary()?;
    if !binary.is_file() {
        return Err(format!("{} not found; place mihomo in the Clash directory", binary.display()));
    }
    let config = store::run_config_path()?;
    if !config.is_file() {
        return Err("No compiled output yet; apply a config first".to_string());
    }
    let yaml = std::fs::read_to_string(&config)
        .map_err(|e| format!("Failed to read compiled output: {e}"))?;
    reserve_ports(&yaml, &binary)?;

    let log_path = store::core_log_path()?;
    // Where this run's output starts: the log is appended to, so the previous
    // run's errors must not be read as this one's.
    let log_start = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Cannot open core log: {e}"))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("Cannot open core log: {e}"))?;

    let mut command = Command::new(&binary);
    command
        .arg("-d")
        .arg(store::root()?)
        .arg("-f")
        .arg(&config)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));

    let mut child = hidden(&mut command)
        .spawn()
        .map_err(|e| format!("Failed to start mihomo: {e}"))?;
    let pid = child.id();

    // A config the core refuses is printed and followed by an exit, usually
    // before any port is bound. Returning that pid would read as "core running"
    // while nothing answers, so hand back what the core said instead.
    std::thread::sleep(Duration::from_millis(300));
    if let Ok(Some(status)) = child.try_wait() {
        return Err(match failure_reason(&log_path, log_start) {
            Some(reason) => format!("mihomo exited right after start ({status}): {reason}"),
            None => format!(
                "mihomo exited right after start ({status}); see {}",
                log_path.display()
            ),
        });
    }

    *guard = Some(child);
    Ok(pid)
}

/// The last error line this run of the core wrote, if it wrote one at all.
fn failure_reason(path: &Path, from: u64) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let text = String::from_utf8_lossy(bytes.get(from as usize..)?);
    text.lines()
        .rev()
        .find(|line| line.contains("level=fatal") || line.contains("level=error"))
        .map(str::to_string)
}

pub fn stop(slot: &CoreSlot) -> Result<(), String> {
    let mut guard = slot.lock().map_err(|_| "Core state lock is poisoned".to_string())?;
    let Some(mut child) = guard.take() else {
        return Ok(());
    };
    child.kill().map_err(|e| format!("Failed to stop mihomo: {e}"))?;
    let _ = child.wait();
    Ok(())
}

/// True when the slot holds a child that has not exited.
pub fn running(slot: &CoreSlot) -> bool {
    match slot.lock() {
        Ok(mut guard) => match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        },
        Err(_) => false,
    }
}

/// The running core's process id, without probing the binary: the home page
/// asks for this every couple of seconds and `status` runs `mihomo -v`.
pub fn current_pid(slot: &CoreSlot) -> Option<u32> {
    let mut guard = slot.lock().ok()?;
    let child = guard.as_mut()?;
    match child.try_wait() {
        Ok(None) => Some(child.id()),
        _ => {
            *guard = None;
            None
        }
    }
}

pub fn status(slot: &CoreSlot) -> CoreStatus {
    let (running, pid) = match slot.lock() {
        Ok(mut guard) => match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => (true, Some(child.id())),
                _ => {
                    *guard = None;
                    (false, None)
                }
            },
            None => (false, None),
        },
        Err(_) => (false, None),
    };

    // The api endpoint is read from the compiled output, which is what the
    // running core was started with.
    let controller = std::fs::read_to_string(store::run_config_path().unwrap_or_default())
        .ok()
        .and_then(|yaml| endpoint(&yaml));
    let api = controller.as_ref().map(|(addr, _)| addr.clone());
    let (api_reachable, api_error) = match (running, controller.as_ref()) {
        (true, Some((addr, secret))) => probe_controller(addr, secret.as_deref()),
        _ => (false, None),
    };

    CoreStatus {
        running,
        pid,
        binary: probe(),
        api,
        api_reachable,
        api_error,
    }
}

/// Whether the controller named by `yaml` answers right now.
pub fn controller_answers(yaml: &str) -> bool {
    match endpoint(yaml) {
        Some((addr, secret)) => probe_controller(&addr, secret.as_deref()).0,
        None => false,
    }
}

/// One short `GET /version`. The address comes from the output the core was
/// started with — never from a guessed default, which is exactly how requests
/// end up on another client's core.
///
/// Two tries with a pause between them: the first can land while a core that was
/// just started is still binding its ports, and a false "unreachable" would
/// restart a healthy core.
fn probe_controller(addr: &str, secret: Option<&str>) -> (bool, Option<String>) {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(600))
        .build()
    {
        Ok(client) => client,
        Err(error) => return (false, Some(format!("Failed to create HTTP client: {error}"))),
    };

    let mut verdict = (false, Some(format!("{addr} does not answer")));
    for attempt in 0..2 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(150));
        }
        let mut request = client.get(format!("http://{addr}/version"));
        if let Some(secret) = secret {
            request = request.bearer_auth(secret);
        }
        verdict = match request.send() {
            Ok(response) if response.status().is_success() => return (true, None),
            Ok(response) if response.status() == reqwest::StatusCode::UNAUTHORIZED => (
                false,
                Some(format!(
                    "{addr} rejected the request (HTTP 401); another program owns that port"
                )),
            ),
            Ok(response) => (
                false,
                Some(format!("{addr} answered HTTP {}", response.status())),
            ),
            Err(error) => (false, Some(format!("{addr} does not answer: {error}"))),
        };
    }
    verdict
}

/// Ask a running core to load the config at `path`.
///
/// Every failure is an error here, including a refused connection: the caller
/// knows whether a core is up, and a core that cannot be reached is usually one
/// still running on the previous output — which no hot reload can move onto a
/// new controller address.
pub fn reload(path: &Path) -> Result<String, String> {
    let yaml = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read compiled output: {e}"))?;
    let (addr, secret) = endpoint(&yaml).unwrap_or_else(unknown_endpoint);

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let mut request = client
        .put(format!("http://{addr}/configs?force=true"))
        .json(&serde_json::json!({ "path": path.to_string_lossy() }));
    if let Some(secret) = secret {
        request = request.bearer_auth(secret);
    }

    match request.send() {
        Ok(response) if response.status().is_success() => Ok("Config hot reloaded".to_string()),
        Ok(response) => Err(format!("Hot reload failed: HTTP {}", response.status())),
        Err(error) => Err(format!("Cannot reach the core controller at {addr}: {error}")),
    }
}

/// Where the running core listens, taken from the output it was started with.
pub fn controller() -> Result<(String, Option<String>), String> {
    let yaml = std::fs::read_to_string(store::run_config_path()?)
        .map_err(|_| "No compiled output yet; apply a config first".to_string())?;
    Ok(endpoint(&yaml).unwrap_or_else(unknown_endpoint))
}

/// Point the compiled output at a controller this app owns.
///
/// mihomo's default is `127.0.0.1:9090`, and that is what every Clash client on
/// the machine asks for, so the second one to start silently ends up with no
/// REST API at all — its connections and proxy list requests then reach the
/// other client's core, which wants a secret, and come back 401. Rewriting the
/// address belongs here rather than in the profile: the profile is the user's
/// and a subscription update replaces it wholesale.
///
/// A value that is not the shared default is a deliberate choice and is kept.
pub fn own_controller(yaml: &str) -> Result<String, String> {
    let address = format!("127.0.0.1:{}", settings::controller_port()?);
    let mut lines: Vec<String> = Vec::with_capacity(yaml.lines().count() + 1);
    let mut seen = false;

    for line in yaml.lines() {
        match line.strip_prefix("external-controller:") {
            Some(value) if !seen => {
                seen = true;
                if is_shared(value) {
                    lines.push(format!("external-controller: {address}"));
                } else {
                    lines.push(line.to_string());
                }
            }
            _ => lines.push(line.to_string()),
        }
    }
    if !seen {
        lines.push(format!("external-controller: {address}"));
    }

    let mut text = lines.join("\n");
    text.push('\n');
    Ok(text)
}

/// `127.0.0.1:9090`, `:9090`, `'0.0.0.0:9090'` — all the same port to everyone
/// else on the machine. Anything without a port is not a valid address anyway.
fn is_shared(value: &str) -> bool {
    let value = value
        .trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .trim();
    match value.rsplit_once(':') {
        Some((_, port)) => port.trim() == "9090",
        None => true,
    }
}

/// Fail loudly when the core could not listen where its config says.
///
/// mihomo does not treat a busy controller port as fatal: it logs one line,
/// keeps proxying and ends up with no REST API at all — and the requests meant
/// for it reach whichever client owns the port. A busy proxy port fails the same
/// quiet way. A leftover core of our own is the usual owner and is ours to stop;
/// anything else is reported before a process is spawned.
fn reserve_ports(yaml: &str, binary: &Path) -> Result<(), String> {
    let controller = endpoint(yaml).map(|(addr, _)| addr);
    let controller_port = controller.as_deref().and_then(port_of);
    let ports = needed_ports(yaml, controller_port);
    if ports.is_empty() || busy_port(&ports).is_none() {
        return Ok(());
    }

    let mut busy = busy_port(&ports);

    // A core of ours left over from a previous run is the usual owner, and it is
    // ours to stop. Only then is waiting for the socket to come free worth it.
    if evict_leftover_cores(binary) {
        let mut waited = 0;
        while busy.is_some() && waited < 20 {
            std::thread::sleep(Duration::from_millis(50));
            busy = busy_port(&ports);
            waited += 1;
        }
    }

    match busy {
        None => Ok(()),
        Some(port) if Some(port) == controller_port => Err(format!(
            "The external controller port {port} is already in use — another Clash client may own \
             it. Apply once so this app moves its controller to a port of its own."
        )),
        Some(port) => Err(format!(
            "Proxy port {port} is already in use by another program; stop that program and start \
             the core again."
        )),
    }
}

/// Every TCP port the core is about to claim: the controller first, then the
/// inbound proxies. Zero means "not configured".
fn needed_ports(yaml: &str, controller_port: Option<u16>) -> Vec<u16> {
    let mut ports: Vec<u16> = controller_port.into_iter().filter(|p| *p > 0).collect();
    let parsed: Option<serde_yaml_ng::Value> = serde_yaml_ng::from_str(yaml).ok();
    let Some(map) = parsed.as_ref().and_then(|value| value.as_mapping()) else {
        return ports;
    };
    for key in ["mixed-port", "port", "socks-port"] {
        let port = map
            .get(serde_yaml_ng::Value::String(key.to_string()))
            .and_then(|value| value.as_u64())
            .filter(|port| *port > 0 && *port <= u16::MAX as u64);
        if let Some(port) = port.map(|port| port as u16) {
            if !ports.contains(&port) {
                ports.push(port);
            }
        }
    }
    ports
}

/// The first of `ports` that cannot be bound. The listener is dropped right
/// away: the only question is whether the address is taken.
fn busy_port(ports: &[u16]) -> Option<u16> {
    ports
        .iter()
        .copied()
        .find(|port| TcpListener::bind(("127.0.0.1", *port)).is_err())
}

fn port_of(address: &str) -> Option<u16> {
    address.rsplit_once(':')?.1.trim().parse().ok()
}

/// Stop cores of ours that outlived the app. Returns whether one was stopped.
///
/// Only the exact binary in this data directory is matched, so another Clash
/// client's core is never touched — those ship their own renamed executable.
/// The process list is queried through PowerShell because a process-image
/// lookup would otherwise need a Win32 dependency for this one call.
#[cfg(windows)]
fn evict_leftover_cores(binary: &Path) -> bool {
    const SCRIPT: &str = "Get-CimInstance Win32_Process -Filter \"Name='mihomo.exe'\" \
                          | ForEach-Object { \"$($_.ProcessId)|$($_.ExecutablePath)\" }";
    let mut command = Command::new("powershell");
    let output = match hidden(&mut command)
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .stdin(Stdio::null())
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return false,
    };

    let ours = normalized(binary);
    let listing = String::from_utf8_lossy(&output.stdout);
    let mut stopped = false;
    for line in listing.lines() {
        let Some((pid, path)) = line.trim().split_once('|') else {
            continue;
        };
        if normalized(Path::new(path.trim())) != ours {
            continue;
        }
        let Ok(pid) = pid.trim().parse::<u32>() else {
            continue;
        };
        let mut kill = Command::new("taskkill");
        if hidden(&mut kill)
            .args(["/PID", &pid.to_string(), "/F"])
            .output()
            .is_ok_and(|output| output.status.success())
        {
            stopped = true;
        }
    }
    stopped
}

#[cfg(not(windows))]
fn evict_leftover_cores(_binary: &Path) -> bool {
    false
}

/// One spelling per path: Windows reports the same file with different casing,
/// separators and optional `\\?\` prefixes.
#[cfg(windows)]
fn normalized(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let text = text.strip_prefix(r"\\?\").unwrap_or(&text);
    text.trim_end_matches('\\').to_lowercase()
}

fn unknown_endpoint() -> (String, Option<String>) {
    let port = settings::controller_port().unwrap_or(9090);
    (format!("127.0.0.1:{port}"), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `controller_port()` persists into the data directory, so point it at a
    /// throwaway one first.
    fn data_dir() {
        let dir = std::env::temp_dir().join(format!("prism-core-core-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let _ = store::CONFIG_DIR.set(dir);
    }

    #[test]
    fn replaces_the_shared_controller_port() {
        data_dir();
        let yaml = "mixed-port: 7890\nexternal-controller: '127.0.0.1:9090'\nrules: []\n";
        let rewritten = own_controller(yaml).unwrap();
        assert!(!rewritten.contains(":9090"), "{rewritten}");
        assert!(
            rewritten.contains("external-controller: 127.0.0.1:"),
            "{rewritten}"
        );
        assert!(rewritten.contains("mixed-port: 7890"), "{rewritten}");
    }

    #[test]
    fn keeps_a_deliberate_controller_port() {
        data_dir();
        let yaml = "external-controller: 0.0.0.0:8443\n";
        assert_eq!(own_controller(yaml).unwrap(), yaml);
    }

    #[test]
    fn appends_when_the_key_is_missing() {
        data_dir();
        let rewritten = own_controller("mode: rule\n").unwrap();
        assert_eq!(rewritten.lines().count(), 2);
        assert!(
            rewritten.contains("external-controller: 127.0.0.1:"),
            "{rewritten}"
        );
    }

    #[test]
    fn stays_idempotent() {
        data_dir();
        let once = own_controller("mode: rule\n").unwrap();
        assert_eq!(own_controller(&once).unwrap(), once);
    }

    #[test]
    fn collects_the_ports_the_core_will_bind() {
        let yaml = "mixed-port: 7890\nsocks-port: 7891\nport: 7890\n";
        assert_eq!(needed_ports(yaml, Some(19090)), vec![19090, 7890, 7891]);
    }

    #[test]
    fn reads_a_port_from_an_address() {
        assert_eq!(port_of("127.0.0.1:19090"), Some(19090));
        assert_eq!(port_of("0.0.0.0:9090"), Some(9090));
        assert_eq!(port_of("localhost"), None);
    }

    #[test]
    fn notices_a_port_that_is_already_bound() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(busy_port(&[port]), Some(port));
        assert_eq!(busy_port(&[]), None);
    }

    #[test]
    fn a_missing_geo_database_does_not_block_an_apply() {
        let output = concat!(
            "level=error msg=\"can't initial GeoIP: can't download MMDB: dial tcp: i/o timeout\"\n",
            "level=fatal msg=\"Parse config error: rules[639] [GEOIP,CN,DIRECT] error: ",
            "can't download MMDB\"\n"
        );
        assert!(!validation_blocks(output));
    }

    #[test]
    fn a_real_config_error_still_blocks_an_apply() {
        let output = "level=fatal msg=\"Parse config error: proxy 0: invalid type\"\n";
        assert!(validation_blocks(output));
        assert!(validation_blocks("configuration file test failed\n"));
    }

    #[test]
    fn a_rejected_config_keeps_the_reason_mihomo_gave() {
        let output = concat!(
            "time=\"2026-10-31T21:49:54+08:00\" level=info msg=\"Start initial configuration\"\n",
            "time=\"2026-10-31T21:49:54+08:00\" level=error msg=\"rules[2] ",
            "[DOMAIN,example.org,SAMPLE] error: proxy [SAMPLE] not found\"\n",
            "configuration file test failed\n"
        );
        assert_eq!(
            validation_reason(output),
            "rules[2] [DOMAIN,example.org,SAMPLE] error: proxy [SAMPLE] not found"
        );
    }
}

/// Pull `external-controller` and `secret` out of a config.
fn endpoint(yaml: &str) -> Option<(String, Option<String>)> {
    let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(yaml).ok()?;
    let map = value.as_mapping()?;

    let addr = map
        .get(serde_yaml_ng::Value::String("external-controller".into()))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().trim_start_matches("http://").trim_end_matches('/'))
        .unwrap_or("127.0.0.1:9090")
        .to_string();

    let secret = map
        .get(serde_yaml_ng::Value::String("secret".into()))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    Some((addr, secret))
}

/// Windows pops a console window for every spawned process unless told not to.
fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

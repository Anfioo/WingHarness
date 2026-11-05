//! `frpc.toml` generation, redacted previews and `frpc verify` before writing.
//!
//! The structured form is the only source of truth; the TOML file is a build
//! artifact rebuilt from it. Every write is verified by the `frpc` the profile
//! would actually run, so an invalid combination is caught before a process
//! ever starts and enters its reconnect loop.

use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{FrpError, FrpResult};
use crate::models::{
    ConfigPreview, ConfigVerifyResult, FrpProfile, SecretRole, Tunnel, TunnelOptions, Workspace,
};
use crate::paths;
use crate::proc::hidden;
use crate::tunnels;

/// `frpc verify` must finish within this window or it is killed.
const VERIFY_TIMEOUT: Duration = Duration::from_secs(20);
const REDACTED: &str = "***";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrpcFile {
    server_addr: String,
    server_port: u16,
    auth: FrpcAuth,
    proxies: Vec<FrpcProxy>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    visitors: Vec<FrpcVisitor>,
}

#[derive(Debug, Serialize)]
struct FrpcAuth {
    method: &'static str,
    token: String,
}

#[derive(Debug, Serialize)]
struct FrpcProxy {
    name: String,
    #[serde(rename = "type")]
    proxy_type: &'static str,
    enabled: bool,
    #[serde(rename = "localIP", skip_serializing_if = "Option::is_none")]
    local_ip: Option<String>,
    #[serde(rename = "localPort", skip_serializing_if = "Option::is_none")]
    local_port: Option<u16>,
    #[serde(rename = "remotePort", skip_serializing_if = "Option::is_none")]
    remote_port: Option<u16>,
    #[serde(rename = "customDomains", skip_serializing_if = "Option::is_none")]
    custom_domains: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subdomain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    locations: Option<Vec<String>>,
    #[serde(rename = "secretKey", skip_serializing_if = "Option::is_none")]
    secret_key: Option<String>,
}

/// One `[[visitors]]` entry — the dialing side of an stcp/xtcp pair.
///
/// frpc keeps visitors in their own table and rejects a proxy that carries
/// `role`, `serverName`, `bindAddr` or `bindPort`.
#[derive(Debug, Serialize)]
struct FrpcVisitor {
    name: String,
    #[serde(rename = "type")]
    visitor_type: &'static str,
    #[serde(rename = "serverName")]
    server_name: String,
    #[serde(rename = "secretKey", skip_serializing_if = "Option::is_none")]
    secret_key: Option<String>,
    #[serde(rename = "bindAddr")]
    bind_addr: String,
    #[serde(rename = "bindPort")]
    bind_port: u16,
}

/// A tunnel serializes as either a proxy or a visitor.
enum FrpcEntry {
    Proxy(FrpcProxy),
    Visitor(FrpcVisitor),
}

/// What `frpc verify` and the atomic write decided.
#[derive(Debug)]
pub struct VerifyOutcome {
    pub result: ConfigVerifyResult,
    /// True when `frpc.toml` was replaced, so the caller must bump the
    /// profile's `configRevision`.
    pub config_changed: bool,
}

/// Build the TOML for one profile from its enabled tunnels.
///
/// `redact` blanks the server token and every `secretKey`, so the same function
/// serves the read-only preview and the file that is written to disk.
pub fn generate(profile: &FrpProfile, tunnels: &[Tunnel], redact: bool) -> FrpResult<String> {
    let token = if redact {
        REDACTED.to_string()
    } else {
        profile.token.clone().unwrap_or_default()
    };

    let mut proxies = Vec::new();
    let mut visitors = Vec::new();
    for tunnel in tunnels
        .iter()
        .filter(|tunnel| tunnel.profile_id == profile.id && tunnel.enabled)
    {
        match to_entry(tunnel, redact)? {
            FrpcEntry::Proxy(proxy) => proxies.push(proxy),
            FrpcEntry::Visitor(visitor) => visitors.push(visitor),
        }
    }

    let file = FrpcFile {
        server_addr: profile.server_addr.clone(),
        server_port: profile.server_port,
        auth: FrpcAuth {
            method: "token",
            token,
        },
        proxies,
        visitors,
    };

    toml::to_string_pretty(&file).map_err(|error| {
        log::warn!("frp_config_serialize_failed profile={} error={error}", profile.id);
        FrpError::internal("The frpc configuration could not be serialized.")
    })
}

/// The redacted TOML the detail drawer shows.
pub fn preview(workspace: &Workspace, profile_id: &str) -> FrpResult<ConfigPreview> {
    let profile = workspace
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| FrpError::not_found("profile", profile_id))?;

    Ok(ConfigPreview {
        profile_id: profile_id.to_string(),
        content: generate(profile, &workspace.tunnels, true)?,
        redacted: true,
        tunnel_count: enabled_tunnel_count(workspace, profile_id),
    })
}

/// Validate the generated config with the profile's own `frpc`, then write it.
///
/// The verification runs against a temporary sibling of `frpc.toml`; only a
/// passing config replaces the real file, and only when its bytes differ. This
/// is the long-running part of a start, so the caller must not hold the
/// workspace lock across this call.
pub fn verify_and_save(workspace: &Workspace, profile_id: &str) -> FrpResult<VerifyOutcome> {
    let profile = workspace
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| FrpError::not_found("profile", profile_id))?;
    let runtime = crate::runtimes::resolve_for_profile(profile, workspace)?;
    let content = generate(profile, &workspace.tunnels, false)?;

    let directory = paths::ensure_profile_dir(profile_id)?;
    let temp_path = directory.join(format!("frpc.verify.{}.toml", uuid::Uuid::new_v4()));
    if let Err(error) = std::fs::write(&temp_path, content.as_bytes()) {
        log::warn!(
            "frp_config_temp_write_failed profile={profile_id} path={} error={error}",
            temp_path.display()
        );
        return Err(FrpError::internal(
            "The generated configuration could not be written.",
        ));
    }

    let verified = match verify_file(Path::new(&runtime.path), &temp_path) {
        Ok(verified) => verified,
        Err(error) => {
            let _ = std::fs::remove_file(&temp_path);
            return Err(error);
        }
    };
    if !verified.valid {
        let _ = std::fs::remove_file(&temp_path);
        return Err(FrpError::config_invalid(verified.raw_output));
    }

    let config_path = paths::config_path(profile_id)?;
    let existing = std::fs::read_to_string(&config_path).unwrap_or_default();
    let config_changed = existing != content;
    if config_changed {
        if let Err(error) = std::fs::rename(&temp_path, &config_path) {
            log::warn!(
                "frp_config_replace_failed profile={profile_id} path={} error={error}",
                config_path.display()
            );
            let _ = std::fs::remove_file(&temp_path);
            return Err(FrpError::internal(
                "The verified configuration could not be installed.",
            ));
        }
    } else {
        let _ = std::fs::remove_file(&temp_path);
    }

    log::info!(
        "frp_config_verified profile={profile_id} changed={config_changed} runtime={}",
        runtime.path
    );
    Ok(VerifyOutcome {
        result: ConfigVerifyResult {
            valid: true,
            message: verified.message,
            raw_output: verified.raw_output,
            config_path: config_path.to_string_lossy().into_owned(),
            sha256: sha256_hex(content.as_bytes()),
        },
        config_changed,
    })
}

fn enabled_tunnel_count(workspace: &Workspace, profile_id: &str) -> u32 {
    workspace
        .tunnels
        .iter()
        .filter(|tunnel| tunnel.profile_id == profile_id && tunnel.enabled)
        .count() as u32
}

fn to_entry(tunnel: &Tunnel, redact: bool) -> FrpResult<FrpcEntry> {
    let options = tunnels::normalize_options(tunnel.tunnel_type, &tunnel.options).map_err(
        |mut error| {
            error.message = format!("Tunnel '{}' is invalid: {}", tunnel.name, error.message);
            error
        },
    )?;

    let mut proxy = FrpcProxy {
        name: tunnel.name.clone(),
        proxy_type: tunnels::type_name(tunnel.tunnel_type),
        enabled: tunnel.enabled,
        local_ip: None,
        local_port: None,
        remote_port: None,
        custom_domains: None,
        subdomain: None,
        locations: None,
        secret_key: None,
    };

    let secret_key = |key: String| {
        if redact {
            REDACTED.to_string()
        } else {
            key
        }
    };

    match options {
        TunnelOptions::Port { remote_port } => {
            proxy.local_ip = Some(tunnel.local_ip.clone());
            proxy.local_port = Some(tunnel.local_port);
            proxy.remote_port = Some(remote_port);
        }
        TunnelOptions::Domain {
            custom_domains,
            subdomain,
            locations,
        } => {
            proxy.local_ip = Some(tunnel.local_ip.clone());
            proxy.local_port = Some(tunnel.local_port);
            proxy.custom_domains = non_empty_list(custom_domains);
            proxy.subdomain = subdomain;
            proxy.locations = non_empty_list(locations);
        }
        TunnelOptions::Secret {
            secret_key: key,
            role,
            server_name,
        } => {
            if role == SecretRole::Visitor {
                // A visitor binds a local port and dials the server tunnel by
                // name; it does not expose anything itself.
                return Ok(FrpcEntry::Visitor(FrpcVisitor {
                    name: tunnel.name.clone(),
                    visitor_type: tunnels::type_name(tunnel.tunnel_type),
                    server_name: server_name.unwrap_or_default(),
                    secret_key: Some(secret_key(key)),
                    bind_addr: tunnel.local_ip.clone(),
                    bind_port: tunnel.local_port,
                }));
            }
            proxy.secret_key = Some(secret_key(key));
            proxy.local_ip = Some(tunnel.local_ip.clone());
            proxy.local_port = Some(tunnel.local_port);
        }
    }

    Ok(FrpcEntry::Proxy(proxy))
}

fn non_empty_list(values: Vec<String>) -> Option<Vec<String>> {
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

struct VerifyOutput {
    valid: bool,
    message: String,
    raw_output: String,
}

fn verify_file(runtime_path: &Path, config_path: &Path) -> FrpResult<VerifyOutput> {
    if !runtime_path.is_file() {
        return Err(FrpError::runtime_missing(
            "The selected frpc binary no longer exists.",
        ));
    }
    if !config_path.is_file() {
        return Err(FrpError::internal(
            "The generated configuration disappeared before verification.",
        ));
    }

    let mut child = hidden(runtime_path)
        .arg("verify")
        .arg("-c")
        .arg(config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            log::warn!(
                "frp_verify_spawn_failed runtime={} error={error}",
                runtime_path.display()
            );
            FrpError::spawn_failed("frpc could not be started for verification.")
        })?;

    let deadline = Instant::now() + VERIFY_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                log::warn!("frp_verify_timeout runtime={}", runtime_path.display());
                return Err(FrpError::config_invalid(format!(
                    "frpc verify timed out after {} seconds.",
                    VERIFY_TIMEOUT.as_secs()
                )));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                log::warn!("frp_verify_wait_failed error={error}");
                return Err(FrpError::internal(
                    "frpc verify could not be awaited.",
                ));
            }
        }
    }

    let output = child.wait_with_output().map_err(|error| {
        log::warn!("frp_verify_output_failed error={error}");
        FrpError::internal("The frpc verify output could not be read.")
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let raw_output = match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("{stdout}\n{stderr}"),
        (false, true) => stdout,
        (true, false) => stderr,
        (true, true) => String::new(),
    };

    if output.status.success() {
        Ok(VerifyOutput {
            valid: true,
            message: if raw_output.is_empty() {
                "The configuration is valid.".to_string()
            } else {
                raw_output.clone()
            },
            raw_output,
        })
    } else {
        Ok(VerifyOutput {
            valid: false,
            message: format!(
                "frpc verify failed with exit code {:?}.",
                output.status.code()
            ),
            raw_output,
        })
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{RuntimePolicy, RuntimeRecord, SecretRole, TunnelType};

    fn profile() -> FrpProfile {
        FrpProfile {
            id: "p1".to_string(),
            name: "Home".to_string(),
            server_addr: "frps.example.com".to_string(),
            server_port: 7000,
            token: Some("super-secret-token".to_string()),
            runtime_policy: RuntimePolicy::Recommended,
            runtime_id: None,
            reconnect_enabled: true,
            note: String::new(),
            config_revision: 0,
            sort_order: 0,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn tunnel(name: &str, tunnel_type: TunnelType, options: TunnelOptions) -> Tunnel {
        Tunnel {
            id: format!("t-{name}"),
            profile_id: "p1".to_string(),
            name: name.to_string(),
            tunnel_type,
            enabled: true,
            local_ip: "127.0.0.1".to_string(),
            local_port: 22,
            options,
            created_at: 1,
            updated_at: 1,
        }
    }

    fn port_tunnel(name: &str, remote_port: u16) -> Tunnel {
        tunnel(name, TunnelType::Tcp, TunnelOptions::Port { remote_port })
    }

    #[test]
    fn generates_tcp_and_redacts_the_token() {
        let raw = generate(&profile(), &[port_tunnel("ssh", 6000)], false).expect("generate");
        assert!(raw.contains("serverAddr = \"frps.example.com\""));
        assert!(raw.contains("serverPort = 7000"));
        assert!(raw.contains("[auth]"));
        assert!(raw.contains("method = \"token\""));
        assert!(raw.contains("super-secret-token"));
        assert!(raw.contains("remotePort = 6000"));
        assert!(raw.contains("localIP = \"127.0.0.1\""));

        let redacted = generate(&profile(), &[port_tunnel("ssh", 6000)], true).expect("generate");
        assert!(redacted.contains("token = \"***\""));
        assert!(!redacted.contains("super-secret-token"));
    }

    #[test]
    fn generates_udp_like_tcp() {
        let mut udp = port_tunnel("dns", 5353);
        udp.tunnel_type = TunnelType::Udp;

        let raw = generate(&profile(), &[udp], true).expect("generate");
        assert!(raw.contains("type = \"udp\""));
        assert!(raw.contains("remotePort = 5353"));
        assert!(raw.contains("localPort = 22"));
    }

    #[test]
    fn verify_reports_a_missing_binary() {
        let directory = crate::store::test_support::scratch("verify-missing");
        let config = directory.join("frpc.toml");
        std::fs::write(&config, b"serverAddr = \"x\"\n").expect("write config");

        let error = match verify_file(&directory.join("frpc.exe"), &config) {
            Err(error) => error,
            Ok(_) => panic!("a missing binary must not verify"),
        };
        assert_eq!(error.code, crate::error::FrpErrorCode::RuntimeMissing);
    }

    #[test]
    fn generates_http_and_https_domains() {
        for tunnel_type in [TunnelType::Http, TunnelType::Https] {
            let tunnel = tunnel(
                "web",
                tunnel_type,
                TunnelOptions::Domain {
                    custom_domains: vec!["app.example.com".to_string()],
                    subdomain: None,
                    locations: vec!["/api".to_string()],
                },
            );
            let raw = generate(&profile(), &[tunnel], true).expect("generate");
            assert!(raw.contains(&format!("type = \"{}\"", tunnels::type_name(tunnel_type))));
            assert!(raw.contains("customDomains"));
            assert!(raw.contains("app.example.com"));
            assert!(raw.contains("locations"));
            assert!(!raw.contains("remotePort"));
        }
    }

    #[test]
    fn generates_stcp_server_and_visitor() {
        let server = tunnel(
            "secret_ssh",
            TunnelType::Stcp,
            TunnelOptions::Secret {
                secret_key: "shared-key".to_string(),
                role: SecretRole::Server,
                server_name: None,
            },
        );
        let mut visitor = tunnel(
            "secret_ssh_visitor",
            TunnelType::Stcp,
            TunnelOptions::Secret {
                secret_key: "shared-key".to_string(),
                role: SecretRole::Visitor,
                server_name: Some("secret_ssh".to_string()),
            },
        );
        visitor.local_port = 9001;

        let raw = generate(&profile(), &[server, visitor], false).expect("generate");
        assert!(!raw.contains("role ="));

        let value: toml::Value = toml::from_str(&raw).expect("valid TOML");
        let proxies = value
            .get("proxies")
            .and_then(toml::Value::as_array)
            .expect("proxies table");
        let visitors = value
            .get("visitors")
            .and_then(toml::Value::as_array)
            .expect("visitors table");
        assert_eq!(proxies.len(), 1);
        assert_eq!(visitors.len(), 1);

        let provider = &proxies[0];
        assert_eq!(
            provider.get("name").and_then(toml::Value::as_str),
            Some("secret_ssh")
        );
        assert_eq!(
            provider.get("type").and_then(toml::Value::as_str),
            Some("stcp")
        );
        assert_eq!(
            provider.get("secretKey").and_then(toml::Value::as_str),
            Some("shared-key")
        );
        assert!(provider.get("serverName").is_none());
        assert!(provider.get("bindPort").is_none());

        let dialer = &visitors[0];
        assert_eq!(
            dialer.get("name").and_then(toml::Value::as_str),
            Some("secret_ssh_visitor")
        );
        assert_eq!(
            dialer.get("serverName").and_then(toml::Value::as_str),
            Some("secret_ssh")
        );
        assert_eq!(
            dialer.get("secretKey").and_then(toml::Value::as_str),
            Some("shared-key")
        );
        assert_eq!(
            dialer.get("bindAddr").and_then(toml::Value::as_str),
            Some("127.0.0.1")
        );
        assert_eq!(
            dialer.get("bindPort").and_then(toml::Value::as_integer),
            Some(9001)
        );

        let redacted = generate(
            &profile(),
            &[tunnel(
                "secret_ssh",
                TunnelType::Xtcp,
                TunnelOptions::Secret {
                    secret_key: "shared-key".to_string(),
                    role: SecretRole::Server,
                    server_name: None,
                },
            )],
            true,
        )
        .expect("generate");
        assert!(redacted.contains("secretKey = \"***\""));
        assert!(!redacted.contains("shared-key"));
    }

    #[test]
    fn disabled_tunnels_are_left_out() {
        let mut disabled = port_tunnel("ssh", 6000);
        disabled.enabled = false;
        let raw = generate(&profile(), &[disabled], true).expect("generate");
        assert!(!raw.contains("[[proxies]]"));
        assert!(!raw.contains("remotePort"));
    }

    #[test]
    fn tunnels_of_other_profiles_are_left_out() {
        let mut foreign = port_tunnel("other", 6001);
        foreign.profile_id = "p2".to_string();
        let raw = generate(&profile(), &[foreign], true).expect("generate");
        assert!(!raw.contains("6001"));
    }

    #[test]
    fn generated_toml_parses_back() {
        let tunnels = vec![
            port_tunnel("ssh", 6000),
            tunnel(
                "web",
                TunnelType::Http,
                TunnelOptions::Domain {
                    custom_domains: vec!["app.example.com".to_string()],
                    subdomain: None,
                    locations: Vec::new(),
                },
            ),
        ];
        let raw = generate(&profile(), &tunnels, true).expect("generate");

        let value: toml::Value = toml::from_str(&raw).expect("valid TOML");
        assert_eq!(
            value.get("serverAddr").and_then(toml::Value::as_str),
            Some("frps.example.com")
        );
        assert_eq!(
            value
                .get("proxies")
                .and_then(toml::Value::as_array)
                .map(Vec::len),
            Some(2)
        );
    }

    #[test]
    fn invalid_options_are_reported_with_the_tunnel_name() {
        let broken = tunnel(
            "web",
            TunnelType::Http,
            TunnelOptions::Domain {
                custom_domains: Vec::new(),
                subdomain: None,
                locations: Vec::new(),
            },
        );
        let error = generate(&profile(), &[broken], true).expect_err("reject");
        assert!(error.message.contains("web"));
    }

    #[test]
    fn preview_counts_enabled_tunnels_and_redacts() {
        let mut workspace = Workspace::default();
        workspace.profiles.push(profile());
        workspace.tunnels.push(port_tunnel("ssh", 6000));
        let mut disabled = port_tunnel("other", 6001);
        disabled.enabled = false;
        workspace.tunnels.push(disabled);

        let preview = preview(&workspace, "p1").expect("preview");
        assert!(preview.redacted);
        assert_eq!(preview.tunnel_count, 1);
        assert!(preview.content.contains("token = \"***\""));
        assert!(!preview.content.contains("super-secret-token"));
    }

    #[test]
    fn preview_of_an_unknown_profile_fails() {
        let workspace = Workspace::default();
        assert!(preview(&workspace, "missing").is_err());
    }

    #[test]
    fn verify_without_a_runtime_reports_runtime_missing() {
        let mut workspace = Workspace::default();
        workspace.profiles.push(profile());
        let error = verify_and_save(&workspace, "p1").expect_err("no runtime");
        assert_eq!(error.code, crate::error::FrpErrorCode::RuntimeMissing);
    }

    #[test]
    fn pinned_profile_without_a_matching_runtime_reports_runtime_missing() {
        let mut workspace = Workspace::default();
        let mut pinned = profile();
        pinned.runtime_policy = RuntimePolicy::Pinned;
        pinned.runtime_id = Some("gone".to_string());
        workspace.profiles.push(pinned);

        let error = verify_and_save(&workspace, "p1").expect_err("missing runtime");
        assert_eq!(error.code, crate::error::FrpErrorCode::RuntimeMissing);
    }

    #[test]
    fn resolution_ignores_a_runtime_for_another_platform() {
        let mut workspace = Workspace::default();
        let mut record = runtime("foreign", "0.68.0", 10);
        record.platform = "linux".to_string();
        workspace.runtimes.push(record);
        workspace.profiles.push(profile());

        // `frpc verify` must resolve exactly what the launcher would spawn, so a
        // record the launcher cannot use is not good enough here either.
        let error = verify_and_save(&workspace, "p1").expect_err("no usable runtime");
        assert_eq!(error.code, crate::error::FrpErrorCode::RuntimeMissing);
    }

    /// Creates a real runtime record pointing at the given version; the file is
    /// not created, so resolution filters it out unless the test makes one.
    fn runtime(id: &str, version: &str, added_at: i64) -> RuntimeRecord {
        let path = crate::store::test_support::scratch("runtime").join(format!("frpc-{id}.exe"));
        std::fs::write(&path, b"stub").expect("write stub");
        RuntimeRecord {
            id: id.to_string(),
            path: path.to_string_lossy().into_owned(),
            version: version.to_string(),
            platform: "windows".to_string(),
            architecture: "x86_64".to_string(),
            sha256: String::new(),
            size_bytes: 4,
            raw_version_output: version.to_string(),
            added_at,
            last_checked_at: None,
        }
    }

    /// End-to-end check against a real `frpc`; skipped by default because it
    /// needs a binary the test machine may not have.
    #[test]
    #[ignore]
    fn verify_and_save_against_a_real_frpc() {
        let mut workspace = Workspace::default();
        let mut profile = profile();
        profile.id = "frp-verify-real".to_string();
        workspace.runtimes.push(RuntimeRecord {
            id: "real".to_string(),
            path: std::env::var("FRPC_PATH").expect("set FRPC_PATH to a real frpc binary"),
            version: "0.61.0".to_string(),
            platform: "windows".to_string(),
            architecture: "x86_64".to_string(),
            sha256: String::new(),
            size_bytes: 0,
            raw_version_output: String::new(),
            added_at: 0,
            last_checked_at: None,
        });
        profile.runtime_id = Some("real".to_string());
        workspace.profiles.push(profile);
        workspace.tunnels.push(port_tunnel("ssh", 6000));

        let _ = crate::store::test_support::data_dir();
        let outcome = verify_and_save(&workspace, "frp-verify-real").expect("verify");
        assert!(outcome.result.valid);
        assert!(outcome.config_changed);
        assert!(Path::new(&outcome.result.config_path).is_file());

        let _ = std::fs::remove_dir_all(paths::profile_dir("frp-verify-real").expect("dir"));
    }
}

//! Import an existing `frpc.toml` as a new profile.
//!
//! Only parsing and the in-memory build of the profile and its tunnels live
//! here; persistence belongs to [`crate::store`], so the caller can validate the
//! whole change and write it in one atomic update. A proxy that cannot be
//! represented is skipped with a warning instead of failing the import, while
//! errors at the server level abort it.
//!
//! Nothing in this module logs a token, a `secretKey` or the configuration text.

use std::collections::HashSet;
use std::path::Path;

use serde::Deserialize;

use crate::error::{FrpError, FrpResult};
use crate::models::{
    ConfigImportPreview, ConfigImportResult, ConfigImportSource, FrpProfile, FrpProfileInput,
    ImportTunnelPreview, RuntimePolicy, SecretRole, TunnelInput, TunnelOptions, TunnelType,
    Workspace,
};
use crate::{profiles, runtimes, tunnels};

/// Refuse configuration files larger than this; `frpc.toml` is tiny.
const MAX_IMPORT_BYTES: u64 = 1024 * 1024;
/// A masked secret, as the redacted preview and some exports write it.
const REDACTED: &str = "***";
const DEFAULT_LOCAL_IP: &str = "127.0.0.1";
const IMPORT_NOTE: &str = "Imported from TOML";

#[derive(Debug, Deserialize)]
struct RawConfig {
    #[serde(rename = "serverAddr", alias = "server_addr", default)]
    server_addr: Option<String>,
    #[serde(rename = "serverPort", alias = "server_port", default)]
    server_port: Option<i64>,
    #[serde(default)]
    auth: Option<RawAuth>,
    #[serde(default)]
    proxies: Vec<RawProxy>,
}

#[derive(Debug, Deserialize)]
struct RawAuth {
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    token: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawProxy {
    #[serde(default)]
    name: Option<String>,
    #[serde(rename = "type", default)]
    proxy_type: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(rename = "localIP", alias = "local_ip", default)]
    local_ip: Option<String>,
    #[serde(rename = "localPort", alias = "local_port", default)]
    local_port: Option<i64>,
    #[serde(rename = "remotePort", alias = "remote_port", default)]
    remote_port: Option<i64>,
    #[serde(rename = "customDomains", alias = "custom_domains", default)]
    custom_domains: Option<Vec<String>>,
    #[serde(default)]
    subdomain: Option<String>,
    #[serde(default)]
    locations: Option<Vec<String>>,
    #[serde(default)]
    role: Option<String>,
    #[serde(rename = "secretKey", alias = "secret_key", default)]
    secret_key: Option<String>,
    #[serde(rename = "serverName", alias = "server_name", default)]
    server_name: Option<String>,
    #[serde(rename = "bindAddr", alias = "bind_addr", default)]
    bind_addr: Option<String>,
    #[serde(rename = "bindPort", alias = "bind_port", default)]
    bind_port: Option<i64>,
}

/// One proxy that passed every rule, ready to be stored as a tunnel.
#[derive(Debug, Clone)]
struct ParsedTunnel {
    name: String,
    tunnel_type: TunnelType,
    enabled: bool,
    local_ip: String,
    local_port: u16,
    options: TunnelOptions,
}

/// The result of reading and parsing one source.
#[derive(Debug, Clone)]
pub struct ParsedConfig {
    pub server_addr: String,
    pub server_port: u16,
    pub token: Option<String>,
    tunnels: Vec<ParsedTunnel>,
    pub warnings: Vec<String>,
}

/// Read the source and parse it. Never writes anything.
pub fn load(source: &ConfigImportSource) -> FrpResult<ParsedConfig> {
    match source {
        ConfigImportSource::Text { content } => parse(content),
        ConfigImportSource::File { path } => parse(&read_file(path)?),
    }
}

/// Parse `frpc.toml` text in the v0.52+ shape, tolerating snake_case keys.
pub fn parse(content: &str) -> FrpResult<ParsedConfig> {
    let raw: RawConfig = toml::from_str(content).map_err(|error| {
        // The display form of a TOML error quotes the offending line, which may
        // hold a token; report only the position, never the content.
        let message = error
            .span()
            .and_then(|span| content.get(..span.start))
            .map(|prefix| {
                format!(
                    "The text is not valid frpc TOML (line {}).",
                    prefix.bytes().filter(|byte| *byte == b'\n').count() + 1
                )
            })
            .unwrap_or_else(|| "The text is not valid frpc TOML.".to_string());
        FrpError::invalid_input("source", message)
    })?;

    let server_addr = raw
        .server_addr
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if server_addr.is_empty() {
        return Err(FrpError::invalid_input(
            "serverAddr",
            "The server address is required.",
        ));
    }

    let server_port = raw.server_port.ok_or_else(|| {
        FrpError::invalid_input("serverPort", "The server port is required.")
    })?;
    let server_port = u16::try_from(server_port)
        .ok()
        .filter(|port| *port != 0)
        .ok_or_else(|| {
            FrpError::invalid_input(
                "serverPort",
                "The server port must be between 1 and 65535.",
            )
        })?;

    let mut warnings = Vec::new();
    let token = raw
        .auth
        .as_ref()
        .and_then(|auth| auth.token.as_deref())
        .and_then(cleaned_secret);

    match raw.auth.as_ref() {
        Some(auth) => {
            if let Some(method) = auth.method.as_deref().map(str::trim).filter(|value| !value.is_empty())
            {
                if !method.eq_ignore_ascii_case("token") {
                    warnings.push(format!(
                        "Unsupported auth method '{method}'; expected 'token'."
                    ));
                }
            }
        }
        None => warnings.push("The auth section is missing; no token was imported.".to_string()),
    }

    if raw.proxies.is_empty() {
        warnings.push("The file contains no proxies.".to_string());
    }

    let mut seen_names: HashSet<String> = HashSet::new();
    let mut tunnels = Vec::new();
    for (index, item) in raw.proxies.into_iter().enumerate() {
        let position = index + 1;
        let Some(name) = item
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
        else {
            warnings.push(format!("Skipped proxy #{position}: the name is empty."));
            continue;
        };

        if !seen_names.insert(name.clone()) {
            warnings.push(format!("Skipped proxy '{name}': the name is duplicated."));
            continue;
        }

        match parse_proxy(&name, &item) {
            Ok(tunnel) => tunnels.push(tunnel),
            Err(reason) => warnings.push(format!("Skipped proxy '{name}': {reason}")),
        }
    }

    Ok(ParsedConfig {
        server_addr,
        server_port,
        token,
        tunnels,
        warnings,
    })
}

/// The read-only view the preview command returns.
pub fn preview(parsed: &ParsedConfig) -> ConfigImportPreview {
    ConfigImportPreview {
        server_addr: parsed.server_addr.clone(),
        server_port: parsed.server_port,
        token_present: parsed.token.is_some(),
        tunnels: parsed
            .tunnels
            .iter()
            .map(|tunnel| ImportTunnelPreview {
                name: tunnel.name.clone(),
                tunnel_type: tunnel.tunnel_type,
                enabled: tunnel.enabled,
                local_ip: tunnel.local_ip.clone(),
                local_port: tunnel.local_port,
                options: tunnel.options.clone(),
            })
            .collect(),
        warnings: parsed.warnings.clone(),
    }
}

/// Build one new profile and all of its tunnels in memory.
///
/// The caller persists the workspace only when this succeeds, so a failure
/// leaves no partial import. Nothing is started here.
pub fn import(
    workspace: &mut Workspace,
    parsed: &ParsedConfig,
    requested_name: Option<&str>,
    apply_token: bool,
    runtime_policy: RuntimePolicy,
    runtime_id: Option<&str>,
) -> FrpResult<ConfigImportResult> {
    let base_name = requested_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("Imported {}", parsed.server_addr));
    let name = unique_profile_name(workspace, &base_name);

    let token = if apply_token {
        parsed.token.clone()
    } else {
        None
    };
    let token_applied = token.is_some();

    let runtime_id = runtime_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    // Resolve before mutating, so a pinned profile with a missing runtime fails
    // without leaving a half-built profile behind.
    let provisional = FrpProfile {
        id: String::new(),
        name: name.clone(),
        server_addr: parsed.server_addr.clone(),
        server_port: parsed.server_port,
        token: token.clone(),
        runtime_policy,
        runtime_id: runtime_id.clone(),
        reconnect_enabled: true,
        note: IMPORT_NOTE.to_string(),
        config_revision: 0,
        sort_order: 0,
        created_at: 0,
        updated_at: 0,
    };
    runtimes::resolve_for_profile(&provisional, workspace)?;

    let profile = profiles::create(
        workspace,
        &FrpProfileInput {
            name,
            server_addr: parsed.server_addr.clone(),
            server_port: parsed.server_port,
            token,
            runtime_policy,
            runtime_id,
            reconnect_enabled: true,
            note: IMPORT_NOTE.to_string(),
        },
    )?;

    let mut warnings = parsed.warnings.clone();
    let mut tunnel_count = 0u32;
    for tunnel in &parsed.tunnels {
        let input = TunnelInput {
            profile_id: profile.id.clone(),
            name: tunnel.name.clone(),
            tunnel_type: tunnel.tunnel_type,
            enabled: tunnel.enabled,
            local_ip: tunnel.local_ip.clone(),
            local_port: tunnel.local_port,
            options: tunnel.options.clone(),
        };
        match tunnels::create(workspace, &input) {
            Ok(_) => tunnel_count += 1,
            Err(error) => {
                warnings.push(format!("Skipped proxy '{}': {}", tunnel.name, error.message))
            }
        }
    }

    // `tunnels::create` bumps the revision per tunnel; a freshly imported
    // profile starts at zero and has never produced a config.
    if let Some(entry) = workspace
        .profiles
        .iter_mut()
        .find(|entry| entry.id == profile.id)
    {
        entry.config_revision = 0;
    }

    if !token_applied {
        warnings.push("The token was not applied; set it manually before connecting.".to_string());
    }

    let profile = profiles::get(workspace, &profile.id)?.clone();
    Ok(ConfigImportResult {
        profile,
        tunnel_count,
        warnings,
        token_applied,
    })
}

fn parse_proxy(name: &str, item: &RawProxy) -> Result<ParsedTunnel, String> {
    let type_text = item
        .proxy_type
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let tunnel_type = match type_text.as_str() {
        "" => return Err("the type is missing".to_string()),
        "tcp" => TunnelType::Tcp,
        "udp" => TunnelType::Udp,
        "http" => TunnelType::Http,
        "https" => TunnelType::Https,
        "stcp" => TunnelType::Stcp,
        "xtcp" => TunnelType::Xtcp,
        other => return Err(format!("unsupported type '{other}'")),
    };

    let enabled = item.enabled.unwrap_or(true);
    let type_name = tunnels::type_name(tunnel_type);

    match tunnel_type {
        TunnelType::Tcp | TunnelType::Udp => {
            let remote_port =
                parse_port(item.remote_port).ok_or_else(|| {
                    format!("remotePort is required for {type_name} tunnels")
                })?;
            let local_port =
                parse_port(item.local_port).ok_or_else(|| "localPort is required".to_string())?;
            Ok(ParsedTunnel {
                name: name.to_string(),
                tunnel_type,
                enabled,
                local_ip: local_ip(item.local_ip.as_deref()),
                local_port,
                options: TunnelOptions::Port { remote_port },
            })
        }
        TunnelType::Http | TunnelType::Https => {
            let custom_domains = cleaned_list(item.custom_domains.as_deref());
            let subdomain = cleaned_text(item.subdomain.as_deref());
            let locations = cleaned_list(item.locations.as_deref());
            if custom_domains.is_empty() && subdomain.is_none() {
                return Err(format!(
                    "customDomains or subdomain is required for {type_name} tunnels"
                ));
            }
            let local_port =
                parse_port(item.local_port).ok_or_else(|| "localPort is required".to_string())?;
            Ok(ParsedTunnel {
                name: name.to_string(),
                tunnel_type,
                enabled,
                local_ip: local_ip(item.local_ip.as_deref()),
                local_port,
                options: TunnelOptions::Domain {
                    custom_domains,
                    subdomain,
                    locations,
                },
            })
        }
        TunnelType::Stcp | TunnelType::Xtcp => {
            let secret_key = item
                .secret_key
                .as_deref()
                .and_then(cleaned_secret)
                .ok_or_else(|| format!("secretKey is required for {type_name} tunnels"))?;

            let role_text = item
                .role
                .as_deref()
                .map(str::trim)
                .unwrap_or_default()
                .to_ascii_lowercase();
            let role = match role_text.as_str() {
                "" | "server" => SecretRole::Server,
                "visitor" => SecretRole::Visitor,
                other => return Err(format!("unsupported role '{other}'")),
            };

            let server_name = cleaned_text(item.server_name.as_deref());
            if role == SecretRole::Visitor && server_name.is_none() {
                return Err("serverName is required for the visitor role".to_string());
            }

            let (local_ip, local_port) = if role == SecretRole::Visitor {
                let bind_port = parse_port(item.bind_port)
                    .ok_or_else(|| "bindPort is required for the visitor role".to_string())?;
                (local_ip(item.bind_addr.as_deref()), bind_port)
            } else {
                let local_port =
                    parse_port(item.local_port).ok_or_else(|| "localPort is required".to_string())?;
                (local_ip(item.local_ip.as_deref()), local_port)
            };

            Ok(ParsedTunnel {
                name: name.to_string(),
                tunnel_type,
                enabled,
                local_ip,
                local_port,
                options: TunnelOptions::Secret {
                    secret_key,
                    role,
                    server_name,
                },
            })
        }
    }
}

fn read_file(path_text: &str) -> FrpResult<String> {
    let trimmed = path_text.trim();
    if trimmed.is_empty() {
        return Err(FrpError::invalid_input(
            "path",
            "A configuration file path is required.",
        ));
    }

    let path = Path::new(trimmed);
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        let message = match error.kind() {
            std::io::ErrorKind::NotFound => "The configuration file does not exist.",
            _ => "The configuration file could not be read.",
        };
        FrpError::invalid_input("path", message)
    })?;

    if metadata.file_type().is_symlink() {
        return Err(FrpError::invalid_input(
            "path",
            "Symbolic links are not supported.",
        ));
    }
    if !metadata.file_type().is_file() {
        return Err(FrpError::invalid_input(
            "path",
            "The selected path is not a file.",
        ));
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if !matches!(extension.as_deref(), Some("toml" | "conf" | "txt")) {
        return Err(FrpError::invalid_input(
            "path",
            "The configuration file must be a .toml, .conf or .txt file.",
        ));
    }

    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(FrpError::invalid_input(
            "path",
            "The configuration file must be 1 MiB or smaller.",
        ));
    }

    let bytes = std::fs::read(path).map_err(|error| {
        log::warn!(
            "frp_config_import_read_failed path={} error={error}",
            path.display()
        );
        FrpError::invalid_input("path", "The configuration file could not be read.")
    })?;
    if bytes.len() as u64 > MAX_IMPORT_BYTES {
        return Err(FrpError::invalid_input(
            "path",
            "The configuration file must be 1 MiB or smaller.",
        ));
    }

    String::from_utf8(bytes).map_err(|_| {
        FrpError::invalid_input("path", "The configuration file must be UTF-8 text.")
    })
}

fn unique_profile_name(workspace: &Workspace, base: &str) -> String {
    if !workspace.profiles.iter().any(|profile| profile.name == base) {
        return base.to_string();
    }
    let mut index = 2u32;
    loop {
        let candidate = format!("{base} ({index})");
        if !workspace
            .profiles
            .iter()
            .any(|profile| profile.name == candidate)
        {
            return candidate;
        }
        index += 1;
    }
}

fn parse_port(value: Option<i64>) -> Option<u16> {
    value
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port != 0)
}

fn local_ip(value: Option<&str>) -> String {
    cleaned_text(value).unwrap_or_else(|| DEFAULT_LOCAL_IP.to_string())
}

fn cleaned_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Trim, then treat an empty or masked value as absent.
fn cleaned_secret(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty() && trimmed != REDACTED).then(|| trimmed.to_string())
}

fn cleaned_list(values: Option<&[String]>) -> Vec<String> {
    values
        .unwrap_or_default()
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::RuntimeRecord;

    const TCP_AND_HTTP: &str = r#"
serverAddr = "frps.example.com"
serverPort = 7000

[auth]
method = "token"
token = "secret-token"

[[proxies]]
name = "ssh"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22
remotePort = 6000

[[proxies]]
name = "web"
type = "http"
localIP = "127.0.0.1"
localPort = 8080
customDomains = ["app.example.com", "  "]
locations = [" /api "]
"#;

    fn workspace_with_runtime() -> Workspace {
        let directory = crate::store::test_support::scratch("frp-import-runtime");
        let path = directory.join("frpc.exe");
        std::fs::write(&path, b"stub").expect("write stub");

        let mut workspace = Workspace::default();
        workspace.runtimes.push(RuntimeRecord {
            id: "runtime-1".to_string(),
            path: path.to_string_lossy().into_owned(),
            version: "0.69.0".to_string(),
            platform: crate::runtime_probe::platform().to_string(),
            architecture: crate::runtime_probe::architecture().to_string(),
            sha256: String::new(),
            size_bytes: 4,
            raw_version_output: String::new(),
            added_at: 1,
            last_checked_at: None,
        });
        workspace
    }

    fn import_text(
        workspace: &mut Workspace,
        text: &str,
        name: Option<&str>,
    ) -> FrpResult<ConfigImportResult> {
        let parsed = parse(text)?;
        import(
            workspace,
            &parsed,
            name,
            true,
            RuntimePolicy::Recommended,
            None,
        )
    }

    fn field(error: &FrpError) -> Option<String> {
        error
            .detail
            .as_ref()
            .and_then(|detail| detail.get("field"))
            .and_then(|field| field.as_str())
            .map(str::to_string)
    }

    #[test]
    fn parses_tcp_and_http() {
        let parsed = parse(TCP_AND_HTTP).expect("parse");
        assert_eq!(parsed.server_addr, "frps.example.com");
        assert_eq!(parsed.server_port, 7000);
        assert_eq!(parsed.token.as_deref(), Some("secret-token"));
        assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
        assert_eq!(parsed.tunnels.len(), 2);

        assert_eq!(parsed.tunnels[0].tunnel_type, TunnelType::Tcp);
        assert_eq!(
            parsed.tunnels[0].options,
            TunnelOptions::Port { remote_port: 6000 }
        );

        assert_eq!(parsed.tunnels[1].tunnel_type, TunnelType::Http);
        assert_eq!(
            parsed.tunnels[1].options,
            TunnelOptions::Domain {
                custom_domains: vec!["app.example.com".to_string()],
                subdomain: None,
                locations: vec!["/api".to_string()],
            }
        );
    }

    #[test]
    fn parses_a_stcp_visitor() {
        let text = r#"
serverAddr = "frps.example.com"
serverPort = 7000

[auth]
token = "secret-token"

[[proxies]]
name = "secret_ssh_visitor"
type = "stcp"
role = "visitor"
serverName = "secret_ssh"
secretKey = "shared-key"
bindAddr = "0.0.0.0"
bindPort = 9001
"#;
        let parsed = parse(text).expect("parse");
        assert_eq!(parsed.tunnels.len(), 1);
        let tunnel = &parsed.tunnels[0];
        assert_eq!(tunnel.tunnel_type, TunnelType::Stcp);
        assert_eq!(tunnel.local_ip, "0.0.0.0");
        assert_eq!(tunnel.local_port, 9001);
        assert_eq!(
            tunnel.options,
            TunnelOptions::Secret {
                secret_key: "shared-key".to_string(),
                role: SecretRole::Visitor,
                server_name: Some("secret_ssh".to_string()),
            }
        );
    }

    #[test]
    fn rejects_invalid_toml() {
        let error = parse("serverAddr = \"x\"\nnot toml at all").expect_err("reject");
        assert_eq!(error.code, crate::error::FrpErrorCode::InvalidInput);
        assert_eq!(field(&error).as_deref(), Some("source"));
        assert!(!error.message.contains("not toml at all"));
    }

    #[test]
    fn rejects_a_missing_server_addr() {
        let error = parse("serverPort = 7000\n").expect_err("reject");
        assert_eq!(error.code, crate::error::FrpErrorCode::InvalidInput);
        assert_eq!(field(&error).as_deref(), Some("serverAddr"));

        let error = parse("serverAddr = \"  \"\nserverPort = 7000\n").expect_err("blank");
        assert_eq!(field(&error).as_deref(), Some("serverAddr"));
    }

    #[test]
    fn rejects_an_invalid_server_port() {
        let error =
            parse("serverAddr = \"frps.example.com\"\nserverPort = 70000\n").expect_err("reject");
        assert_eq!(field(&error).as_deref(), Some("serverPort"));
    }

    #[test]
    fn skips_a_tcp_proxy_without_a_remote_port() {
        let text = r#"
serverAddr = "frps.example.com"
serverPort = 7000

[[proxies]]
name = "ssh"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22
"#;
        let parsed = parse(text).expect("parse");
        assert!(parsed.tunnels.is_empty());
        assert_eq!(
            parsed
                .warnings
                .iter()
                .filter(|warning| warning.contains("remotePort"))
                .count(),
            1,
            "{:?}",
            parsed.warnings
        );
        assert!(parsed.warnings.iter().any(|warning| warning.contains("ssh")));
    }

    #[test]
    fn skips_duplicate_proxy_names() {
        let text = r#"
serverAddr = "frps.example.com"
serverPort = 7000

[[proxies]]
name = "ssh"
type = "tcp"
localPort = 22
remotePort = 6000

[[proxies]]
name = " ssh "
type = "tcp"
localPort = 23
remotePort = 6001
"#;
        let parsed = parse(text).expect("parse");
        assert_eq!(parsed.tunnels.len(), 1);
        assert_eq!(
            parsed
                .warnings
                .iter()
                .filter(|warning| warning.contains("duplicated"))
                .count(),
            1,
            "{:?}",
            parsed.warnings
        );
    }

    #[test]
    fn treats_a_masked_token_as_absent() {
        let text = r#"
serverAddr = "frps.example.com"
serverPort = 7000

[auth]
token = "***"

[[proxies]]
name = "ssh"
type = "tcp"
localPort = 22
remotePort = 6000
"#;
        let parsed = parse(text).expect("parse");
        assert_eq!(parsed.token, None);

        let preview = preview(&parsed);
        assert!(!preview.token_present);

        let mut workspace = workspace_with_runtime();
        let result = import_text(&mut workspace, text, None).expect("import");
        assert!(!result.token_applied);
        assert_eq!(result.profile.token, None);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("token was not applied")));
    }

    #[test]
    fn apply_token_false_keeps_the_token_out() {
        let parsed = parse(TCP_AND_HTTP).expect("parse");
        let mut workspace = workspace_with_runtime();
        let result = import(
            &mut workspace,
            &parsed,
            None,
            false,
            RuntimePolicy::Recommended,
            None,
        )
        .expect("import");

        assert!(!result.token_applied);
        assert_eq!(result.profile.token, None);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("token was not applied")));
    }

    #[test]
    fn import_creates_one_profile_with_every_tunnel() {
        let parsed = parse(TCP_AND_HTTP).expect("parse");
        let mut workspace = workspace_with_runtime();
        let result = import(
            &mut workspace,
            &parsed,
            None,
            true,
            RuntimePolicy::Recommended,
            None,
        )
        .expect("import");

        assert_eq!(result.tunnel_count, 2);
        assert_eq!(result.profile.name, "Imported frps.example.com");
        assert_eq!(result.profile.server_addr, "frps.example.com");
        assert_eq!(result.profile.server_port, 7000);
        assert_eq!(result.profile.token.as_deref(), Some("secret-token"));
        assert!(result.token_applied);
        assert!(result.profile.reconnect_enabled);
        assert_eq!(result.profile.config_revision, 0);
        assert_eq!(result.profile.note, IMPORT_NOTE);

        assert_eq!(workspace.profiles.len(), 1);
        assert_eq!(workspace.tunnels.len(), 2);
        assert!(workspace
            .tunnels
            .iter()
            .all(|tunnel| tunnel.profile_id == result.profile.id));
    }

    #[test]
    fn reimporting_appends_a_counter_to_the_name() {
        let mut workspace = workspace_with_runtime();
        let first = import_text(&mut workspace, TCP_AND_HTTP, None).expect("first");
        let second = import_text(&mut workspace, TCP_AND_HTTP, None).expect("second");
        let third = import_text(&mut workspace, TCP_AND_HTTP, Some("Imported frps.example.com"))
            .expect("third");

        assert_eq!(first.profile.name, "Imported frps.example.com");
        assert_eq!(second.profile.name, "Imported frps.example.com (2)");
        assert_eq!(third.profile.name, "Imported frps.example.com (3)");
        assert_eq!(workspace.profiles.len(), 3, "no profile is overwritten");
    }

    #[test]
    fn a_failed_import_leaves_the_workspace_unchanged() {
        let mut workspace = workspace_with_runtime();
        let before = workspace.clone();

        let error = import(
            &mut workspace,
            &parse(TCP_AND_HTTP).expect("parse"),
            None,
            true,
            RuntimePolicy::Pinned,
            Some("missing-runtime"),
        )
        .expect_err("pinned runtime is missing");

        assert_eq!(error.code, crate::error::FrpErrorCode::RuntimeMissing);
        assert_eq!(workspace, before);
    }

    #[test]
    fn preview_reports_the_tunnels_and_warnings() {
        let text = r#"
serverAddr = "frps.example.com"
serverPort = 7000

[[proxies]]
name = "ssh"
type = "tcp"
localPort = 22
"#;
        let preview = preview(&parse(text).expect("parse"));
        assert_eq!(preview.server_addr, "frps.example.com");
        assert_eq!(preview.server_port, 7000);
        assert!(!preview.token_present);
        assert!(preview.tunnels.is_empty());
        assert!(!preview.warnings.is_empty());
    }

    #[test]
    fn file_source_rejects_paths_that_are_not_importable() {
        let directory = crate::store::test_support::scratch("frp-import-file");

        let missing = load(&ConfigImportSource::File {
            path: directory.join("missing.toml").to_string_lossy().into_owned(),
        })
        .expect_err("missing file");
        assert_eq!(field(&missing).as_deref(), Some("path"));
        assert!(missing.message.contains("does not exist"));

        let wrong = directory.join("frpc.json");
        std::fs::write(&wrong, b"{}").expect("write");
        let error = load(&ConfigImportSource::File {
            path: wrong.to_string_lossy().into_owned(),
        })
        .expect_err("wrong extension");
        assert!(error.message.contains(".toml"));

        let valid = directory.join("frpc.toml");
        std::fs::write(&valid, TCP_AND_HTTP).expect("write");
        let parsed = load(&ConfigImportSource::File {
            path: valid.to_string_lossy().into_owned(),
        })
        .expect("load");
        assert_eq!(parsed.tunnels.len(), 2);
    }

    #[test]
    fn text_source_parses_without_touching_disk() {
        let parsed = load(&ConfigImportSource::Text {
            content: TCP_AND_HTTP.to_string(),
        })
        .expect("load");
        assert_eq!(parsed.tunnels.len(), 2);
        assert!(load(&ConfigImportSource::Text {
            content: "garbage".to_string(),
        })
        .is_err());
    }
}

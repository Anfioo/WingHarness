//! Tunnel CRUD, the six tunnel types and their type-specific validation.
//!
//! A tunnel carries one of three option shapes (`port`, `domain`, `secret`) and
//! the shape must match its type; [`normalize_options`] is the single place
//! that decides this, so the form, the config generator and the store all
//! enforce the same rules.

use std::collections::HashMap;

use crate::error::{FrpError, FrpResult};
use crate::models::{
    SecretRole, Tunnel, TunnelInput, TunnelOptions, TunnelType, TunnelView, Workspace,
};
use crate::store::unix_now;

const MAX_NAME_CHARS: usize = 80;

/// Every tunnel, or only those of one profile, in display order. Each row
/// carries the profile name so the all-profiles table needs a single call.
pub fn list(workspace: &Workspace, profile_id: Option<&str>) -> Vec<TunnelView> {
    let names: HashMap<&str, &str> = workspace
        .profiles
        .iter()
        .map(|profile| (profile.id.as_str(), profile.name.as_str()))
        .collect();

    let mut tunnels: Vec<&Tunnel> = workspace
        .tunnels
        .iter()
        .filter(|tunnel| profile_id.is_none_or(|id| tunnel.profile_id == id))
        .collect();
    tunnels.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.name.cmp(&right.name))
    });

    tunnels
        .into_iter()
        .map(|tunnel| TunnelView {
            tunnel: tunnel.clone(),
            profile_name: names
                .get(tunnel.profile_id.as_str())
                .map(|name| (*name).to_string())
                .unwrap_or_default(),
        })
        .collect()
}

pub fn create(workspace: &mut Workspace, input: &TunnelInput) -> FrpResult<Tunnel> {
    let tunnel = normalize(workspace, None, input)?;
    let now = unix_now();
    let tunnel = Tunnel {
        id: uuid::Uuid::new_v4().to_string(),
        created_at: now,
        updated_at: now,
        ..tunnel
    };
    bump_profile_revision(workspace, &tunnel.profile_id);
    workspace.tunnels.push(tunnel.clone());
    Ok(tunnel)
}

pub fn update(workspace: &mut Workspace, id: &str, input: &TunnelInput) -> FrpResult<Tunnel> {
    let index = workspace
        .tunnels
        .iter()
        .position(|tunnel| tunnel.id == id)
        .ok_or_else(|| FrpError::not_found("tunnel", id))?;
    let normalized = normalize(workspace, Some(id), input)?;
    let previous_profile = workspace.tunnels[index].profile_id.clone();

    let tunnel = &mut workspace.tunnels[index];
    tunnel.profile_id = normalized.profile_id.clone();
    tunnel.name = normalized.name;
    tunnel.tunnel_type = normalized.tunnel_type;
    tunnel.enabled = normalized.enabled;
    tunnel.local_ip = normalized.local_ip;
    tunnel.local_port = normalized.local_port;
    tunnel.options = normalized.options;
    tunnel.updated_at = unix_now();
    let updated = tunnel.clone();

    bump_profile_revision(workspace, &updated.profile_id);
    if previous_profile != updated.profile_id {
        bump_profile_revision(workspace, &previous_profile);
    }
    Ok(updated)
}

pub fn delete(workspace: &mut Workspace, id: &str) -> FrpResult<()> {
    let index = workspace
        .tunnels
        .iter()
        .position(|tunnel| tunnel.id == id)
        .ok_or_else(|| FrpError::not_found("tunnel", id))?;
    let removed = workspace.tunnels.remove(index);
    bump_profile_revision(workspace, &removed.profile_id);
    Ok(())
}

/// The type name `frpc.toml` expects.
pub(crate) fn type_name(tunnel_type: TunnelType) -> &'static str {
    match tunnel_type {
        TunnelType::Tcp => "tcp",
        TunnelType::Udp => "udp",
        TunnelType::Http => "http",
        TunnelType::Https => "https",
        TunnelType::Stcp => "stcp",
        TunnelType::Xtcp => "xtcp",
    }
}

/// Check one option shape against its tunnel type and return it trimmed.
///
/// Used by the store on the way in and by the config generator on the way out,
/// so a tunnel that somehow reached `frp.json` still cannot produce a config
/// `frpc` would reject.
pub(crate) fn normalize_options(
    tunnel_type: TunnelType,
    options: &TunnelOptions,
) -> FrpResult<TunnelOptions> {
    match (tunnel_type, options) {
        (TunnelType::Tcp | TunnelType::Udp, TunnelOptions::Port { remote_port }) => {
            if *remote_port == 0 {
                return Err(FrpError::invalid_input(
                    "remotePort",
                    "The remote port must be between 1 and 65535.",
                ));
            }
            Ok(TunnelOptions::Port {
                remote_port: *remote_port,
            })
        }
        (
            TunnelType::Http | TunnelType::Https,
            TunnelOptions::Domain {
                custom_domains,
                subdomain,
                locations,
            },
        ) => {
            let custom_domains = clean_list(custom_domains);
            let subdomain = non_empty(subdomain.as_deref());
            if custom_domains.is_empty() && subdomain.is_none() {
                return Err(FrpError::invalid_input(
                    "customDomains",
                    "HTTP and HTTPS tunnels require a custom domain or a subdomain.",
                ));
            }
            Ok(TunnelOptions::Domain {
                custom_domains,
                subdomain,
                locations: clean_list(locations),
            })
        }
        (
            TunnelType::Stcp | TunnelType::Xtcp,
            TunnelOptions::Secret {
                secret_key,
                role,
                server_name,
            },
        ) => {
            if secret_key.trim().is_empty() {
                return Err(FrpError::invalid_input(
                    "secretKey",
                    "STCP and XTCP tunnels require a secret key.",
                ));
            }
            let server_name = non_empty(server_name.as_deref());
            if *role == SecretRole::Visitor && server_name.is_none() {
                return Err(FrpError::invalid_input(
                    "serverName",
                    "A visitor tunnel requires the name of the server tunnel.",
                ));
            }
            Ok(TunnelOptions::Secret {
                secret_key: secret_key.trim().to_string(),
                role: *role,
                server_name,
            })
        }
        _ => Err(FrpError::invalid_input(
            "options",
            "The tunnel options do not match the tunnel type.",
        )),
    }
}

fn normalize(
    workspace: &Workspace,
    existing_id: Option<&str>,
    input: &TunnelInput,
) -> FrpResult<Tunnel> {
    if !workspace
        .profiles
        .iter()
        .any(|profile| profile.id == input.profile_id)
    {
        return Err(FrpError::not_found("profile", &input.profile_id));
    }

    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(FrpError::invalid_input(
            "name",
            "The tunnel name must be between 1 and 80 characters.",
        ));
    }
    let duplicate = workspace.tunnels.iter().any(|tunnel| {
        tunnel.profile_id == input.profile_id
            && tunnel.name == name
            && Some(tunnel.id.as_str()) != existing_id
    });
    if duplicate {
        return Err(FrpError::conflict(
            "A tunnel with this name already exists in the profile.",
        ));
    }

    let local_ip = input.local_ip.trim();
    if local_ip.is_empty() {
        return Err(FrpError::invalid_input(
            "localIp",
            "The local address is required.",
        ));
    }
    if input.local_port == 0 {
        return Err(FrpError::invalid_input(
            "localPort",
            "The local port must be between 1 and 65535.",
        ));
    }

    Ok(Tunnel {
        id: String::new(),
        profile_id: input.profile_id.clone(),
        name: name.to_string(),
        tunnel_type: input.tunnel_type,
        enabled: input.enabled,
        local_ip: local_ip.to_string(),
        local_port: input.local_port,
        options: normalize_options(input.tunnel_type, &input.options)?,
        created_at: 0,
        updated_at: 0,
    })
}

fn bump_profile_revision(workspace: &mut Workspace, profile_id: &str) {
    if let Some(profile) = workspace
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
    {
        profile.config_revision += 1;
        profile.updated_at = unix_now();
    }
}

fn clean_list(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{FrpProfile, FrpProfileInput, RuntimePolicy};

    fn workspace() -> (Workspace, String) {
        let mut workspace = Workspace::default();
        let profile = crate::profiles::create(
            &mut workspace,
            &FrpProfileInput {
                name: "Home".to_string(),
                server_addr: "frps.example.com".to_string(),
                server_port: 7000,
                token: None,
                runtime_policy: RuntimePolicy::Recommended,
                runtime_id: None,
                reconnect_enabled: true,
                note: String::new(),
            },
        )
        .expect("seed profile");
        (workspace, profile.id)
    }

    fn port_input(profile_id: &str, name: &str, remote_port: u16) -> TunnelInput {
        TunnelInput {
            profile_id: profile_id.to_string(),
            name: name.to_string(),
            tunnel_type: TunnelType::Tcp,
            enabled: true,
            local_ip: "127.0.0.1".to_string(),
            local_port: 22,
            options: TunnelOptions::Port { remote_port },
        }
    }

    fn domain_input(profile_id: &str, name: &str, tunnel_type: TunnelType) -> TunnelInput {
        TunnelInput {
            profile_id: profile_id.to_string(),
            name: name.to_string(),
            tunnel_type,
            enabled: true,
            local_ip: "127.0.0.1".to_string(),
            local_port: 8080,
            options: TunnelOptions::Domain {
                custom_domains: vec![" app.example.com ".to_string(), "  ".to_string()],
                subdomain: None,
                locations: vec![" /api ".to_string()],
            },
        }
    }

    fn secret_input(
        profile_id: &str,
        tunnel_type: TunnelType,
        role: SecretRole,
        server_name: Option<&str>,
    ) -> TunnelInput {
        TunnelInput {
            profile_id: profile_id.to_string(),
            name: "secret-ssh".to_string(),
            tunnel_type,
            enabled: true,
            local_ip: "127.0.0.1".to_string(),
            local_port: 22,
            options: TunnelOptions::Secret {
                secret_key: " shared-key ".to_string(),
                role,
                server_name: server_name.map(str::to_string),
            },
        }
    }

    #[test]
    fn accepts_all_six_types() {
        let (mut workspace, profile_id) = workspace();

        let tcp = create(&mut workspace, &port_input(&profile_id, "tcp", 6000)).expect("tcp");
        assert_eq!(tcp.tunnel_type, TunnelType::Tcp);

        let mut udp = port_input(&profile_id, "udp", 6001);
        udp.tunnel_type = TunnelType::Udp;
        assert!(create(&mut workspace, &udp).is_ok());

        let http = domain_input(&profile_id, "web-http", TunnelType::Http);
        assert!(create(&mut workspace, &http).is_ok());
        let https = domain_input(&profile_id, "web-https", TunnelType::Https);
        assert!(create(&mut workspace, &https).is_ok());
        assert!(create(
            &mut workspace,
            &secret_input(&profile_id, TunnelType::Stcp, SecretRole::Server, None)
        )
        .is_ok());
        let mut visitor =
            secret_input(&profile_id, TunnelType::Xtcp, SecretRole::Visitor, None);
        visitor.name = "visitor".to_string();
        visitor.options = TunnelOptions::Secret {
            secret_key: " shared-key ".to_string(),
            role: SecretRole::Visitor,
            server_name: Some("secret-ssh".to_string()),
        };
        assert!(create(&mut workspace, &visitor).is_ok());

        let stored = workspace
            .tunnels
            .iter()
            .find(|tunnel| tunnel.name == "web-http")
            .expect("http tunnel");
        match &stored.options {
            TunnelOptions::Domain {
                custom_domains,
                locations,
                ..
            } => {
                assert_eq!(custom_domains, &vec!["app.example.com".to_string()]);
                assert_eq!(locations, &vec!["/api".to_string()]);
            }
            other => panic!("unexpected options: {other:?}"),
        }

        let secret = workspace
            .tunnels
            .iter()
            .find(|tunnel| tunnel.name == "secret-ssh")
            .expect("secret tunnel");
        match &secret.options {
            TunnelOptions::Secret { secret_key, .. } => assert_eq!(secret_key, "shared-key"),
            other => panic!("unexpected options: {other:?}"),
        }
    }

    #[test]
    fn rejects_invalid_ports() {
        let (mut workspace, profile_id) = workspace();

        let remote = port_input(&profile_id, "tcp", 0);
        assert!(create(&mut workspace, &remote).is_err());

        let mut local = port_input(&profile_id, "tcp", 6000);
        local.local_port = 0;
        assert!(create(&mut workspace, &local).is_err());
    }

    #[test]
    fn rejects_http_without_domains_or_subdomain() {
        let (mut workspace, profile_id) = workspace();
        let mut input = domain_input(&profile_id, "web", TunnelType::Http);
        input.options = TunnelOptions::Domain {
            custom_domains: vec!["   ".to_string()],
            subdomain: Some("  ".to_string()),
            locations: Vec::new(),
        };
        let error = create(&mut workspace, &input).expect_err("reject");
        assert_eq!(error.code, crate::error::FrpErrorCode::InvalidInput);
    }

    #[test]
    fn accepts_a_subdomain_only_tunnel() {
        let (mut workspace, profile_id) = workspace();
        let mut input = domain_input(&profile_id, "web", TunnelType::Https);
        input.options = TunnelOptions::Domain {
            custom_domains: Vec::new(),
            subdomain: Some(" demo ".to_string()),
            locations: Vec::new(),
        };
        let created = create(&mut workspace, &input).expect("create");
        match created.options {
            TunnelOptions::Domain { subdomain, .. } => {
                assert_eq!(subdomain.as_deref(), Some("demo"))
            }
            other => panic!("unexpected options: {other:?}"),
        }
    }

    #[test]
    fn rejects_secret_tunnels_without_key_or_server_name() {
        let (mut workspace, profile_id) = workspace();

        let mut no_key = secret_input(&profile_id, TunnelType::Stcp, SecretRole::Server, None);
        no_key.options = TunnelOptions::Secret {
            secret_key: "  ".to_string(),
            role: SecretRole::Server,
            server_name: None,
        };
        assert!(create(&mut workspace, &no_key).is_err());

        let no_name = secret_input(&profile_id, TunnelType::Stcp, SecretRole::Visitor, None);
        let error = create(&mut workspace, &no_name).expect_err("visitor needs serverName");
        assert_eq!(error.code, crate::error::FrpErrorCode::InvalidInput);

        // A server-role tunnel does not need one.
        assert!(create(
            &mut workspace,
            &secret_input(&profile_id, TunnelType::Stcp, SecretRole::Server, None)
        )
        .is_ok());
    }

    #[test]
    fn rejects_options_that_do_not_match_the_type() {
        let (mut workspace, profile_id) = workspace();

        let mut wrong = port_input(&profile_id, "web", 6000);
        wrong.tunnel_type = TunnelType::Http;
        assert!(create(&mut workspace, &wrong).is_err());

        let mut wrong = domain_input(&profile_id, "web", TunnelType::Http);
        wrong.tunnel_type = TunnelType::Tcp;
        assert!(create(&mut workspace, &wrong).is_err());
    }

    #[test]
    fn rejects_duplicate_names_within_a_profile() {
        let (mut workspace, profile_id) = workspace();
        create(&mut workspace, &port_input(&profile_id, "ssh", 6000)).expect("create");

        let error = create(&mut workspace, &port_input(&profile_id, " ssh ", 6001))
            .expect_err("duplicate");
        assert_eq!(error.code, crate::error::FrpErrorCode::Conflict);

        // The same name in another profile is fine.
        let other = crate::profiles::create(
            &mut workspace,
            &FrpProfileInput {
                name: "Office".to_string(),
                server_addr: "frps.example.com".to_string(),
                server_port: 7000,
                token: None,
                runtime_policy: RuntimePolicy::Recommended,
                runtime_id: None,
                reconnect_enabled: true,
                note: String::new(),
            },
        )
        .expect("second profile");
        assert!(create(&mut workspace, &port_input(&other.id, "ssh", 6000)).is_ok());

        // Renaming a tunnel onto its own name is not a duplicate.
        let tunnel_id = workspace
            .tunnels
            .iter()
            .find(|tunnel| tunnel.profile_id == profile_id)
            .expect("tunnel")
            .id
            .clone();
        let edit = port_input(&profile_id, "ssh", 6002);
        let updated = update(&mut workspace, &tunnel_id, &edit).expect("update");
        assert_eq!(updated.options, TunnelOptions::Port { remote_port: 6002 });
    }

    #[test]
    fn changes_bump_the_profile_revision() {
        let (mut workspace, profile_id) = workspace();
        let created = create(&mut workspace, &port_input(&profile_id, "ssh", 6000)).expect("create");
        assert_eq!(profile_revision(&workspace, &profile_id), 1);

        update(
            &mut workspace,
            &created.id,
            &port_input(&profile_id, "ssh", 6001),
        )
        .expect("update");
        assert_eq!(profile_revision(&workspace, &profile_id), 2);

        delete(&mut workspace, &created.id).expect("delete");
        assert_eq!(profile_revision(&workspace, &profile_id), 3);
        assert!(workspace.tunnels.is_empty());
    }

    #[test]
    fn moving_a_tunnel_bumps_both_profiles() {
        let (mut workspace, profile_id) = workspace();
        let other = crate::profiles::create(
            &mut workspace,
            &FrpProfileInput {
                name: "Office".to_string(),
                server_addr: "frps.example.com".to_string(),
                server_port: 7000,
                token: None,
                runtime_policy: RuntimePolicy::Recommended,
                runtime_id: None,
                reconnect_enabled: true,
                note: String::new(),
            },
        )
        .expect("second profile");
        let created = create(&mut workspace, &port_input(&profile_id, "ssh", 6000)).expect("create");
        let before = (
            profile_revision(&workspace, &profile_id),
            profile_revision(&workspace, &other.id),
        );

        let moved = port_input(&other.id, "ssh", 6000);
        update(&mut workspace, &created.id, &moved).expect("update");

        assert_eq!(profile_revision(&workspace, &profile_id), before.0 + 1);
        assert_eq!(profile_revision(&workspace, &other.id), before.1 + 1);
    }

    #[test]
    fn list_filters_and_carries_the_profile_name() {
        let (mut workspace, profile_id) = workspace();
        create(&mut workspace, &port_input(&profile_id, "ssh", 6000)).expect("create");

        let all = list(&workspace, None);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].profile_name, "Home");

        assert_eq!(list(&workspace, Some(&profile_id)).len(), 1);
        assert!(list(&workspace, Some("missing")).is_empty());
    }

    #[test]
    fn create_rejects_an_unknown_profile() {
        let (mut workspace, _) = workspace();
        let error = create(&mut workspace, &port_input("missing", "ssh", 6000))
            .expect_err("unknown profile");
        assert_eq!(error.code, crate::error::FrpErrorCode::NotFound);
    }

    fn profile_revision(workspace: &Workspace, profile_id: &str) -> i64 {
        workspace
            .profiles
            .iter()
            .find(|profile: &&FrpProfile| profile.id == profile_id)
            .map(|profile| profile.config_revision)
            .expect("profile")
    }
}

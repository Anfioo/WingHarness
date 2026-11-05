//! Profile CRUD, ordering, revision tracking and delete cascade.
//!
//! Everything here works on an in-memory [`Workspace`]; persistence belongs to
//! [`crate::store`]. Each function leaves the workspace consistent, so the
//! caller can persist it in one write once the whole change succeeded.

use std::collections::HashMap;
use std::path::Path;

use crate::error::{FrpError, FrpResult};
use crate::models::{FrpProfile, FrpProfileInput, RuntimePolicy, Workspace};
use crate::paths;
use crate::store::unix_now;

const MAX_NAME_CHARS: usize = 80;

/// Profiles in display order.
pub fn list(workspace: &Workspace) -> Vec<FrpProfile> {
    let mut profiles = workspace.profiles.clone();
    profiles.sort_by(|left, right| {
        left.sort_order
            .cmp(&right.sort_order)
            .then_with(|| left.created_at.cmp(&right.created_at))
    });
    profiles
}

pub fn get<'a>(workspace: &'a Workspace, id: &str) -> FrpResult<&'a FrpProfile> {
    workspace
        .profiles
        .iter()
        .find(|profile| profile.id == id)
        .ok_or_else(|| FrpError::not_found("profile", id))
}

pub fn create(workspace: &mut Workspace, input: &FrpProfileInput) -> FrpResult<FrpProfile> {
    let normalized = normalize(input)?;
    let now = unix_now();
    let profile = FrpProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: normalized.name,
        server_addr: normalized.server_addr,
        server_port: normalized.server_port,
        token: normalized.token,
        runtime_policy: normalized.runtime_policy,
        runtime_id: normalized.runtime_id,
        reconnect_enabled: normalized.reconnect_enabled,
        note: normalized.note,
        config_revision: 0,
        sort_order: next_sort_order(workspace),
        created_at: now,
        updated_at: now,
    };
    workspace.profiles.push(profile.clone());
    Ok(profile)
}

pub fn update(
    workspace: &mut Workspace,
    id: &str,
    input: &FrpProfileInput,
) -> FrpResult<FrpProfile> {
    let normalized = normalize(input)?;
    let index = workspace
        .profiles
        .iter()
        .position(|profile| profile.id == id)
        .ok_or_else(|| FrpError::not_found("profile", id))?;

    let existing = &workspace.profiles[index];
    // Only the fields that reach `frpc.toml` invalidate a running process; the
    // display name and the note do not.
    let config_changed = existing.server_addr != normalized.server_addr
        || existing.server_port != normalized.server_port
        || existing.token != normalized.token
        || existing.runtime_policy != normalized.runtime_policy
        || existing.runtime_id != normalized.runtime_id;

    let profile = &mut workspace.profiles[index];
    profile.name = normalized.name;
    profile.server_addr = normalized.server_addr;
    profile.server_port = normalized.server_port;
    profile.token = normalized.token;
    profile.runtime_policy = normalized.runtime_policy;
    profile.runtime_id = normalized.runtime_id;
    profile.reconnect_enabled = normalized.reconnect_enabled;
    profile.note = normalized.note;
    profile.updated_at = unix_now();
    if config_changed {
        profile.config_revision += 1;
    }
    Ok(profile.clone())
}

/// Remove a profile and everything attached to it.
///
/// The caller stops the profile's process first; this function then drops its
/// tunnels, deletes `profiles/<id>/` and `logs/<id>/`, and only after both
/// succeeded removes the profile itself. A directory that cannot be deleted
/// leaves the workspace untouched, so nothing ever points at a profile whose
/// files are already gone.
pub fn delete(workspace: &mut Workspace, id: &str) -> FrpResult<()> {
    let index = workspace
        .profiles
        .iter()
        .position(|profile| profile.id == id)
        .ok_or_else(|| FrpError::not_found("profile", id))?;

    workspace.tunnels.retain(|tunnel| tunnel.profile_id != id);
    remove_dir(&paths::profile_dir(id)?)?;
    remove_dir(&paths::log_dir(id)?)?;
    workspace.profiles.remove(index);
    log::info!("frp_profile_deleted profile={id}");
    Ok(())
}

/// Order profiles to match `ids`. Unknown ids are ignored; profiles missing
/// from `ids` keep their relative order at the end.
pub fn reorder(workspace: &mut Workspace, ids: &[String]) -> FrpResult<()> {
    let mut remaining: HashMap<String, FrpProfile> = workspace
        .profiles
        .drain(..)
        .map(|profile| (profile.id.clone(), profile))
        .collect();
    let mut ordered = Vec::with_capacity(remaining.len());

    for id in ids {
        if let Some(profile) = remaining.remove(id) {
            ordered.push(profile);
        }
    }

    let mut rest: Vec<FrpProfile> = remaining.into_values().collect();
    rest.sort_by(|left, right| {
        left.sort_order
            .cmp(&right.sort_order)
            .then_with(|| left.created_at.cmp(&right.created_at))
    });
    ordered.extend(rest);

    for (index, profile) in ordered.iter_mut().enumerate() {
        profile.sort_order = index as i64;
    }
    workspace.profiles = ordered;
    Ok(())
}

fn next_sort_order(workspace: &Workspace) -> i64 {
    workspace
        .profiles
        .iter()
        .map(|profile| profile.sort_order)
        .max()
        .map(|max| max + 1)
        .unwrap_or(0)
}

struct NormalizedProfile {
    name: String,
    server_addr: String,
    server_port: u16,
    token: Option<String>,
    runtime_policy: RuntimePolicy,
    runtime_id: Option<String>,
    reconnect_enabled: bool,
    note: String,
}

fn normalize(input: &FrpProfileInput) -> FrpResult<NormalizedProfile> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(FrpError::invalid_input(
            "name",
            "The profile name must be between 1 and 80 characters.",
        ));
    }

    let server_addr = input.server_addr.trim();
    if server_addr.is_empty() {
        return Err(FrpError::invalid_input(
            "serverAddr",
            "The server address is required.",
        ));
    }
    let lower = server_addr.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Err(FrpError::invalid_input(
            "serverAddr",
            "The server address must not include a protocol prefix.",
        ));
    }

    if input.server_port == 0 {
        return Err(FrpError::invalid_input(
            "serverPort",
            "The server port must be between 1 and 65535.",
        ));
    }

    let runtime_id = input
        .runtime_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if input.runtime_policy == RuntimePolicy::Pinned && runtime_id.is_none() {
        return Err(FrpError::invalid_input(
            "runtimeId",
            "A runtime must be selected when the runtime policy is pinned.",
        ));
    }

    Ok(NormalizedProfile {
        name: name.to_string(),
        server_addr: server_addr.to_string(),
        server_port: input.server_port,
        token: input
            .token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        runtime_policy: input.runtime_policy,
        runtime_id,
        reconnect_enabled: input.reconnect_enabled,
        note: input.note.trim().to_string(),
    })
}

fn remove_dir(directory: &Path) -> FrpResult<()> {
    match std::fs::remove_dir_all(directory) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            log::warn!(
                "frp_profile_dir_remove_failed path={} error={error}",
                directory.display()
            );
            Err(FrpError::internal(
                "The profile data directory could not be deleted.",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SecretRole, Tunnel, TunnelOptions, TunnelType};

    fn input(name: &str) -> FrpProfileInput {
        FrpProfileInput {
            name: name.to_string(),
            server_addr: " frps.example.com ".to_string(),
            server_port: 7000,
            token: Some(" token ".to_string()),
            runtime_policy: RuntimePolicy::Recommended,
            runtime_id: None,
            reconnect_enabled: true,
            note: "  note  ".to_string(),
        }
    }

    fn tunnel(profile_id: &str, name: &str) -> Tunnel {
        Tunnel {
            id: uuid::Uuid::new_v4().to_string(),
            profile_id: profile_id.to_string(),
            name: name.to_string(),
            tunnel_type: TunnelType::Stcp,
            enabled: true,
            local_ip: "127.0.0.1".to_string(),
            local_port: 22,
            options: TunnelOptions::Secret {
                secret_key: "shared".to_string(),
                role: SecretRole::Server,
                server_name: None,
            },
            created_at: unix_now(),
            updated_at: unix_now(),
        }
    }

    #[test]
    fn creates_and_updates_a_profile() {
        let mut workspace = Workspace::default();
        let created = create(&mut workspace, &input("Home")).expect("create");

        assert_eq!(created.name, "Home");
        assert_eq!(created.server_addr, "frps.example.com");
        assert_eq!(created.token.as_deref(), Some("token"));
        assert_eq!(created.note, "note");
        assert_eq!(created.sort_order, 0);
        assert_eq!(created.config_revision, 0);
        assert_eq!(list(&workspace).len(), 1);

        let mut edit = input("Home Lab");
        edit.server_port = 7001;
        let updated = update(&mut workspace, &created.id, &edit).expect("update");
        assert_eq!(updated.name, "Home Lab");
        assert_eq!(updated.server_port, 7001);
        assert_eq!(updated.created_at, created.created_at);
    }

    #[test]
    fn only_config_fields_bump_the_revision() {
        let mut workspace = Workspace::default();
        let created = create(&mut workspace, &input("Home")).expect("create");

        let mut cosmetic = input("Home renamed");
        cosmetic.note = "another note".to_string();
        cosmetic.reconnect_enabled = false;
        let updated = update(&mut workspace, &created.id, &cosmetic).expect("update");
        assert_eq!(updated.config_revision, 0, "name/note/reconnect are not config");

        let mut network = input("Home renamed");
        network.token = Some("new-token".to_string());
        let updated = update(&mut workspace, &created.id, &network).expect("update");
        assert_eq!(updated.config_revision, 1);

        let mut again = input("Home renamed");
        again.token = Some("new-token".to_string());
        let updated = update(&mut workspace, &created.id, &again).expect("unchanged update");
        assert_eq!(updated.config_revision, 1, "an identical update must not bump");
    }

    #[test]
    fn rejects_invalid_fields() {
        let mut workspace = Workspace::default();

        let mut blank = input("Home");
        blank.name = "   ".to_string();
        assert!(create(&mut workspace, &blank).is_err());

        let long = "名".repeat(81);
        let mut too_long = input(&long);
        too_long.name = long;
        assert!(create(&mut workspace, &too_long).is_err());

        let mut protocol = input("Home");
        protocol.server_addr = "https://frps.example.com".to_string();
        assert!(create(&mut workspace, &protocol).is_err());

        let mut port = input("Home");
        port.server_port = 0;
        assert!(create(&mut workspace, &port).is_err());

        let mut pinned = input("Home");
        pinned.runtime_policy = RuntimePolicy::Pinned;
        assert!(create(&mut workspace, &pinned).is_err());

        assert!(workspace.profiles.is_empty());
    }

    #[test]
    fn accepts_eighty_characters() {
        let mut workspace = Workspace::default();
        let name = "a".repeat(80);
        let mut valid = input(&name);
        valid.name = name;
        assert!(create(&mut workspace, &valid).is_ok());
    }

    #[test]
    fn reorder_follows_given_ids() {
        let mut workspace = Workspace::default();
        let first = create(&mut workspace, &input("one")).expect("create");
        let second = create(&mut workspace, &input("two")).expect("create");
        let third = create(&mut workspace, &input("three")).expect("create");

        reorder(
            &mut workspace,
            &[third.id.clone(), first.id.clone(), second.id.clone()],
        )
        .expect("reorder");
        let ids: Vec<String> = list(&workspace)
            .into_iter()
            .map(|profile| profile.id)
            .collect();
        assert_eq!(ids, vec![third.id.clone(), first.id.clone(), second.id.clone()]);
        assert!(list(&workspace)
            .iter()
            .enumerate()
            .all(|(index, profile)| profile.sort_order == index as i64));

        // Unknown ids are ignored; missing ones keep their order at the end.
        reorder(&mut workspace, &["missing".to_string(), third.id.clone()]).expect("partial");
        let ids: Vec<String> = list(&workspace)
            .into_iter()
            .map(|profile| profile.id)
            .collect();
        assert_eq!(ids.len(), 3);
        assert_eq!(ids[0], third.id);
    }

    #[test]
    fn delete_cascades_to_tunnels_and_directories() {
        crate::store::test_support::data_dir();
        let mut workspace = Workspace::default();
        let created = create(&mut workspace, &input("Home")).expect("create");
        workspace.tunnels.push(tunnel(&created.id, "ssh"));
        workspace.tunnels.push(tunnel("someone-else", "other"));

        let config_dir = paths::ensure_profile_dir(&created.id).expect("profile dir");
        std::fs::write(config_dir.join("frpc.toml"), "serverAddr = \"x\"\n").expect("write");
        let log_dir = paths::ensure_log_dir(&created.id).expect("log dir");
        std::fs::write(log_dir.join("frpc.20260101.log"), "line\n").expect("write");

        delete(&mut workspace, &created.id).expect("delete");

        assert!(workspace.profiles.is_empty());
        assert_eq!(workspace.tunnels.len(), 1);
        assert_eq!(workspace.tunnels[0].profile_id, "someone-else");
        assert!(!config_dir.exists());
        assert!(!log_dir.exists());
    }

    #[test]
    fn delete_of_an_unknown_profile_fails() {
        let mut workspace = Workspace::default();
        let error = delete(&mut workspace, "missing").expect_err("delete");
        assert_eq!(error.code, crate::error::FrpErrorCode::NotFound);
    }
}

//! Profiles, credentials, host keys and preferences.
//!
//! Persistence lives in `store` (including the plaintext credentials) and
//! `host_keys`; these functions only validate arguments and forward.

use crate::error::{ServerError, ServerResult};
use crate::models::{
    AuthKind, HostKeyRecord, SecretKind, ServerPrefs, ServerProfile, ServerProfileInput,
    ServerProfilesView,
};
use crate::ssh::auth::PRIVATE_KEY_MAX_BYTES;
use crate::store::Store;
use crate::{host_keys, legacy_secrets, ServerState};

/// Boundary violations, tagged so the UI can distinguish them from real
/// internal failures. There is no dedicated error code for them yet.
fn invalid(message: &'static str) -> ServerError {
    ServerError::internal(message).with_detail(serde_json::json!({ "code": "invalid-input" }))
}

fn require_id(id: &str) -> ServerResult<&str> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err(invalid("The profile id is required."));
    }
    Ok(trimmed)
}

fn validate_input(input: &ServerProfileInput) -> ServerResult<()> {
    if input.name.trim().is_empty() {
        return Err(invalid("The profile name is required."));
    }
    if input.host.trim().is_empty() {
        return Err(invalid("The host is required."));
    }
    if input.username.trim().is_empty() {
        return Err(invalid("The user name is required."));
    }
    if input.port == 0 {
        return Err(invalid("The port must be between 1 and 65535."));
    }
    if input.auth_kind == AuthKind::PrivateKey {
        let key = input.private_key.as_deref().unwrap_or("");
        if key.trim().is_empty() {
            return Err(invalid("A private key is required for key authentication."));
        }
        if key.len() as u64 > PRIVATE_KEY_MAX_BYTES {
            return Err(invalid("The private key is too large."));
        }
    }
    Ok(())
}

/// One-shot migration of the v1 keychain entries into the plaintext fields.
///
/// Runs only while `servers.json` carries an old version. A profile whose read
/// fails keeps the file unversioned, so the next `server_profiles_list` retries;
/// the profile list itself still loads. No secret is ever logged.
async fn migrate_legacy_keychain(store: &Store) -> ServerResult<()> {
    let mut failed = false;

    for profile in store.profiles()? {
        let mut profile_failed = false;

        if profile.password.is_none() {
            match legacy_secrets::get(&profile.id, SecretKind::Password).await {
                Ok(Some(value)) => {
                    if let Err(error) = store.set_secret(&profile.id, SecretKind::Password, &value)
                    {
                        log::error!(
                            "server_legacy_secret_save_failed profile={} kind=password error={error}",
                            profile.id
                        );
                        profile_failed = true;
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    log::error!(
                        "server_legacy_secret_read_failed profile={} kind=password error={error}",
                        profile.id
                    );
                    profile_failed = true;
                }
            }
        }

        if profile.passphrase.is_none() {
            match legacy_secrets::get(&profile.id, SecretKind::Passphrase).await {
                Ok(Some(value)) => {
                    if let Err(error) =
                        store.set_secret(&profile.id, SecretKind::Passphrase, &value)
                    {
                        log::error!(
                            "server_legacy_secret_save_failed profile={} kind=passphrase error={error}",
                            profile.id
                        );
                        profile_failed = true;
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    log::error!(
                        "server_legacy_secret_read_failed profile={} kind=passphrase error={error}",
                        profile.id
                    );
                    profile_failed = true;
                }
            }
        }

        if profile_failed {
            failed = true;
        } else if let Err(error) = legacy_secrets::clear_profile(&profile.id).await {
            // The values are in servers.json now; a stale entry only wastes a slot.
            log::warn!(
                "server_legacy_secret_clear_failed profile={} error={error}",
                profile.id
            );
        }
    }

    if failed {
        return Ok(());
    }
    store.mark_migrated()
}

pub(crate) async fn list(_state: &ServerState) -> ServerResult<ServerProfilesView> {
    let store = Store::open()?;
    if store.needs_secret_migration() {
        if let Err(error) = migrate_legacy_keychain(&store).await {
            log::warn!("server_legacy_secret_migration_failed error={error}");
        }
    }
    store.snapshot()
}

pub(crate) async fn create(
    _state: &ServerState,
    input: ServerProfileInput,
) -> ServerResult<ServerProfile> {
    validate_input(&input)?;
    Store::open()?.create(&input)
}

pub(crate) async fn update(
    _state: &ServerState,
    id: &str,
    input: ServerProfileInput,
) -> ServerResult<ServerProfile> {
    let id = require_id(id)?;
    validate_input(&input)?;
    Store::open()?.update(id, &input)
}

/// Delete a profile and everything attached to it: host key record and any
/// keychain entry left over from the v1 format.
pub(crate) async fn delete(state: &ServerState, id: &str) -> ServerResult<()> {
    let id = require_id(id)?;

    state.connections.close_profile(id).await?;
    if !Store::open()?.delete(id)? {
        return Err(ServerError::not_found(id));
    }

    // The profile is already gone; cleanup failures must not resurrect it.
    if let Err(error) = legacy_secrets::clear_profile(id).await {
        log::warn!("server_profile_legacy_secrets_clear_failed profile={id} error={error}");
    }
    if let Err(error) = host_keys::forget(id) {
        log::warn!("server_profile_host_key_forget_failed profile={id} error={error}");
    }
    log::info!("server_profile_deleted profile={id}");
    Ok(())
}

pub(crate) async fn reorder(_state: &ServerState, ids: Vec<String>) -> ServerResult<()> {
    Store::open()?.reorder(&ids)
}

pub(crate) async fn secret_set(
    _state: &ServerState,
    profile_id: &str,
    kind: SecretKind,
    value: &str,
) -> ServerResult<()> {
    let profile_id = require_id(profile_id)?;
    Store::open()?.set_secret(profile_id, kind, value)
}

pub(crate) async fn secret_clear(
    _state: &ServerState,
    profile_id: &str,
    kind: SecretKind,
) -> ServerResult<()> {
    let profile_id = require_id(profile_id)?;
    Store::open()?.clear_secret(profile_id, kind)
}

pub(crate) async fn host_key_get(
    _state: &ServerState,
    profile_id: &str,
) -> ServerResult<Option<HostKeyRecord>> {
    let profile_id = require_id(profile_id)?;
    host_keys::get(profile_id)
}

pub(crate) async fn host_key_forget(_state: &ServerState, profile_id: &str) -> ServerResult<()> {
    let profile_id = require_id(profile_id)?;
    host_keys::forget(profile_id)
}

pub(crate) async fn host_key_trust_pending(
    _state: &ServerState,
    profile_id: &str,
    fingerprint: &str,
) -> ServerResult<()> {
    let profile_id = require_id(profile_id)?;
    let fingerprint = fingerprint.trim();
    if fingerprint.is_empty() {
        return Err(invalid("The fingerprint is required."));
    }
    host_keys::trust_pending(profile_id, fingerprint)
}

pub(crate) async fn prefs_get(_state: &ServerState) -> ServerResult<ServerPrefs> {
    Store::open()?.prefs()
}

pub(crate) async fn prefs_set(
    _state: &ServerState,
    prefs: ServerPrefs,
) -> ServerResult<ServerPrefs> {
    Store::open()?.set_prefs(&prefs)
}

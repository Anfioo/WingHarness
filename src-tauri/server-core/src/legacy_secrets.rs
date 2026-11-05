//! Read-only access to the keychain entries of the v1 format.
//!
//! This module exists only for the one-shot migration that moves credentials
//! from the OS keychain into `servers.json`. New credentials always go to the
//! store as plain text; nothing here ever writes a keychain entry.
//!
//! Every keyring call runs on the blocking pool (the Windows credential API
//! can block for seconds), and no error or log line ever carries the secret.

use crate::error::{ServerError, ServerResult};
use crate::models::SecretKind;

/// Keychain service every v1 entry of this feature lives under.
pub const SERVICE: &str = "com.anfioo.mabangprojectworkflows.server";

/// `server:<profileId>:<kind>` — the account name of one entry.
pub fn entry_name(profile_id: &str, kind: SecretKind) -> String {
    format!("server:{profile_id}:{}", kind.entry_suffix())
}

/// Read a secret. A missing entry is `Ok(None)`, not an error.
pub async fn get(profile_id: &str, kind: SecretKind) -> ServerResult<Option<String>> {
    let entry = entry_name(profile_id, kind);
    blocking(move || match keyring::Entry::new(SERVICE, &entry) {
        Ok(handle) => match handle.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(keychain_error("read", &error)),
        },
        Err(error) => Err(keychain_error("open", &error)),
    })
    .await
}

/// Remove a secret. Clearing a missing entry succeeds.
pub async fn clear(profile_id: &str, kind: SecretKind) -> ServerResult<()> {
    let entry = entry_name(profile_id, kind);
    blocking(move || match keyring::Entry::new(SERVICE, &entry) {
        Ok(handle) => match handle.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(keychain_error("delete", &error)),
        },
        Err(error) => Err(keychain_error("open", &error)),
    })
    .await
}

/// Drop both entries of a profile; used after a successful migration and when
/// a profile is deleted.
pub async fn clear_profile(profile_id: &str) -> ServerResult<()> {
    clear(profile_id, SecretKind::Password).await?;
    clear(profile_id, SecretKind::Passphrase).await
}

async fn blocking<T, F>(work: F) -> ServerResult<T>
where
    F: FnOnce() -> ServerResult<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| {
            log::warn!("server_secret_task_failed error={error}");
            ServerError::internal("The credential store is unavailable.")
        })?
}

/// Keychain failures carry the operation and the platform message only — the
/// account name is safe to log, the secret never is.
fn keychain_error(operation: &str, error: &keyring::Error) -> ServerError {
    log::warn!("server_keychain_failed operation={operation} error={error}");
    ServerError::internal(format!(
        "The credential store could not {operation} the entry."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_name_uses_the_frozen_layout() {
        assert_eq!(
            entry_name("abc", SecretKind::Password),
            "server:abc:password"
        );
        assert_eq!(
            entry_name("abc", SecretKind::Passphrase),
            "server:abc:passphrase"
        );
    }

    #[test]
    fn service_matches_the_plan() {
        assert_eq!(SERVICE, "com.anfioo.mabangprojectworkflows.server");
    }
}

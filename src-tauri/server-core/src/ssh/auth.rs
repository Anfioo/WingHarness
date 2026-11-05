//! Credential loading and authentication.
//!
//! Credentials come from the profile's plaintext fields in `servers.json`: a
//! password, a private key's text (capped at `PRIVATE_KEY_MAX_BYTES`), and an
//! optional key passphrase. Nothing is read from the keychain or from disk, and
//! nothing here ever puts a secret into a log line or an error message.

use std::sync::Arc;

use russh::client::AuthResult;

use super::client::Client;
use crate::error::{ServerError, ServerResult};
use crate::models::{AuthKind, ServerProfile};

/// Largest private key text the connect flow will accept.
pub(crate) const PRIVATE_KEY_MAX_BYTES: u64 = 1024 * 1024;

/// A rejection that is not the server's fault, tagged so the credential
/// prompt knows what to ask for.
fn credential_error(reason: &'static str) -> ServerError {
    ServerError::auth_failed().with_detail(serde_json::json!({ "code": reason }))
}

/// Run password or public-key authentication for one profile.
pub(crate) async fn authenticate(
    handle: &mut russh::client::Handle<Client>,
    profile: &ServerProfile,
) -> ServerResult<()> {
    match profile.auth_kind {
        AuthKind::Password => {
            let password = profile
                .password
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| credential_error("missing-credential"))?;
            let result = handle
                .authenticate_password(&profile.username, password)
                .await
                .map_err(|error| unexpected(error_text(&error)))?;
            expect_success(result)
        }
        AuthKind::PrivateKey => {
            let text = profile
                .private_key
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| credential_error("missing-credential"))?;
            if text.len() as u64 > PRIVATE_KEY_MAX_BYTES {
                return Err(ServerError::file_too_large(
                    text.len() as u64,
                    PRIVATE_KEY_MAX_BYTES,
                ));
            }
            let passphrase = profile
                .passphrase
                .as_deref()
                .filter(|value| !value.is_empty());
            let key = russh::keys::decode_secret_key(text, passphrase).map_err(|error| {
                log::warn!("server_ssh_key_decode_failed error={error}");
                credential_error("invalid-private-key")
            })?;

            let hash_algorithm = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|error| unexpected(error_text(&error)))?
                .flatten();
            let result = handle
                .authenticate_publickey(
                    &profile.username,
                    russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash_algorithm),
                )
                .await
                .map_err(|error| unexpected(error_text(&error)))?;
            expect_success(result)
        }
    }
}

fn expect_success(result: AuthResult) -> ServerResult<()> {
    match result {
        AuthResult::Success => Ok(()),
        AuthResult::Failure {
            remaining_methods, ..
        } => Err(ServerError::auth_failed().with_detail(serde_json::json!({
            "code": "rejected",
            "remainingMethods": remaining_methods.iter().map(String::from).collect::<Vec<_>>(),
        }))),
    }
}

/// Transport failures during authentication keep the auth-failed code: that
/// is the only failure the credential prompt can act on.
fn unexpected(message: String) -> ServerError {
    log::warn!("server_ssh_auth_transport_failed error={message}");
    ServerError::auth_failed().with_detail(serde_json::json!({ "code": "transport" }))
}

/// russh error text never contains credentials, but keep extraction in one
/// place so that stays true.
fn error_text(error: &russh::Error) -> String {
    error.to_string()
}

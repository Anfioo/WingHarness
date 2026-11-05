//! russh client `Handler`: captures the host key, decides whether it may be
//! trusted, and exposes its SHA256 fingerprint (`SHA256:` + base64, no
//! padding) to the connect flow.

use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine as _};
use ring::digest;

use crate::host_keys::{self, HostKeyVerdict};
use crate::models::HostKeyRecord;

/// Unique id of one connection, stable for the lifetime of the pool entry.
pub(crate) fn new_connection_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// `SHA256:<base64 of the SHA256 of the key blob>`, OpenSSH's format.
pub(crate) fn fingerprint(public_key: &russh::keys::PublicKey) -> String {
    use russh::keys::PublicKeyBase64 as _;

    let digest = digest::digest(&digest::SHA256, &public_key.public_key_bytes());
    format!("SHA256:{}", STANDARD_NO_PAD.encode(digest.as_ref()))
}

/// The key the server presented, plus what the trust policy made of it.
#[derive(Debug, Clone)]
pub(crate) struct PresentedHostKey {
    pub(crate) algorithm: String,
    pub(crate) fingerprint: String,
    pub(crate) verdict: HostKeyVerdict,
}

/// Shared slot the handler fills and the connect flow reads after the
/// handshake, whatever its outcome.
#[derive(Debug, Default)]
pub(crate) struct HostKeyProbe {
    presented: Mutex<Option<PresentedHostKey>>,
}

impl HostKeyProbe {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    fn store(&self, presented: PresentedHostKey) {
        if let Ok(mut slot) = self.presented.lock() {
            *slot = Some(presented);
        }
    }

    pub(crate) fn take(&self) -> Option<PresentedHostKey> {
        self.presented
            .lock()
            .ok()
            .and_then(|mut slot| slot.take())
    }
}

/// The handler russh calls while it validates the host key.
pub(crate) struct Client {
    probe: std::sync::Arc<HostKeyProbe>,
    record: Option<HostKeyRecord>,
    trust_host_key: bool,
}

impl Client {
    pub(crate) fn new(
        probe: std::sync::Arc<HostKeyProbe>,
        record: Option<HostKeyRecord>,
        trust_host_key: bool,
    ) -> Self {
        Self {
            probe,
            record,
            trust_host_key,
        }
    }
}

impl russh::client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let public_key = server_public_key.public_key();
        let algorithm = public_key.algorithm().to_string();
        let fingerprint = fingerprint(&public_key);
        let verdict = host_keys::evaluate(self.record.as_ref(), &fingerprint);

        // A changed key is refused even when `trustHostKey` is set: the user
        // has to forget the old record first (§5.3).
        let accepted = match verdict {
            HostKeyVerdict::Trusted => true,
            HostKeyVerdict::Unknown => self.trust_host_key,
            HostKeyVerdict::Mismatch { .. } => false,
        };

        log::info!(
            "server_ssh_host_key presented algorithm={algorithm} fingerprint={fingerprint} accepted={accepted}"
        );
        self.probe.store(PresentedHostKey {
            algorithm,
            fingerprint,
            verdict,
        });
        Ok(accepted)
    }
}

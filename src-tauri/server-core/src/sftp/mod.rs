//! Remote filesystem access over the SFTP subsystem of a live connection.
//!
//! One `SftpHandle` per profile: the subsystem is opened lazily by
//! `ConnectionManager::sftp` and reused by the file panes and the transfer
//! engine.

pub(crate) mod ops;
pub(crate) mod paths;
pub(crate) mod transfer;

use std::fmt;

use russh::Channel;
use russh_sftp::client::fs::File;
use russh_sftp::client::SftpSession;

use crate::error::{ServerError, ServerResult};
use crate::models::SftpEntry;

/// A profile's SFTP subsystem.
pub struct SftpHandle {
    pub(crate) profile_id: String,
    session: SftpSession,
}

impl fmt::Debug for SftpHandle {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SftpHandle")
            .field("profile_id", &self.profile_id)
            .finish()
    }
}

impl SftpHandle {
    /// Start the `sftp` subsystem on a fresh session channel of the profile's
    /// connection.
    ///
    /// The caller (the connection pool) owns the `russh` handle; this only
    /// takes the channel it just opened.
    pub(crate) async fn new(
        profile_id: impl Into<String>,
        channel: Channel<russh::client::Msg>,
    ) -> ServerResult<Self> {
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| ServerError::internal(format!("Failed to open the SFTP subsystem: {error}")))?;

        let session = SftpSession::new(channel.into_stream())
            .await
            .map_err(|error| ServerError::internal(format!("Failed to initialise SFTP: {error}")))?;

        Ok(Self {
            profile_id: profile_id.into(),
            session,
        })
    }

    /// The logged-in user's home directory, used as the initial remote path.
    pub async fn home(&self) -> ServerResult<String> {
        ops::home(&self.session).await
    }

    /// List one directory. Symlinks are reported, never followed.
    pub async fn list(&self, path: &str) -> ServerResult<Vec<SftpEntry>> {
        ops::list(&self.session, path).await
    }

    pub async fn stat(&self, path: &str) -> ServerResult<SftpEntry> {
        ops::stat(&self.session, path).await
    }

    pub async fn mkdir(&self, path: &str) -> ServerResult<()> {
        ops::mkdir(&self.session, path).await
    }

    pub async fn rename(&self, from: &str, to: &str) -> ServerResult<()> {
        ops::rename(&self.session, from, to).await
    }

    /// Delete one entry. `is_dir` asks for a recursive delete.
    pub async fn remove(&self, path: &str, is_dir: bool) -> ServerResult<()> {
        ops::remove(&self.session, path, is_dir).await
    }

    /// Read a whole file, refusing anything above `max_bytes`.
    pub async fn read_file(&self, path: &str, max_bytes: u64) -> ServerResult<Vec<u8>> {
        ops::read_file(&self.session, path, max_bytes).await
    }

    pub async fn write_file(&self, path: &str, data: &[u8]) -> ServerResult<()> {
        ops::write_file(&self.session, path, data).await
    }

    /// Open a file for reading at `offset`; the transfer engine drives the
    /// reads so pause / resume can keep their own position.
    pub async fn open_read(&self, path: &str, offset: u64) -> ServerResult<File> {
        ops::open_read(&self.session, path, offset).await
    }

    /// Open a file for writing at `offset`, truncating only when it is zero.
    pub async fn open_write(&self, path: &str, offset: u64) -> ServerResult<File> {
        ops::open_write(&self.session, path, offset).await
    }
}

//! Connection pool: one SSH connection per profile, many shell channels per
//! connection, plus the SFTP subsystem handle that shares the same connection.

pub(crate) mod auth;
pub(crate) mod client;
pub(crate) mod session;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use russh::client::Msg;

use crate::error::{ServerError, ServerResult};
use crate::host_keys::{self, HostKeyVerdict};
use crate::models::{ConnectOutcome, MetricsSample, ServerProfile, SessionInfo};
use crate::monitor::{self, MetricsHandle};
use crate::store::{self, unix_now, Store};
use crate::sftp::SftpHandle;

use self::client::{PresentedHostKey, HostKeyProbe};

/// Lifecycle of one profile's connection, mirrored by the tab's status dot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    Idle,
    Connecting,
    Ready,
    Failed,
}

/// One live shell. The write half is behind its own async mutex so a write
/// never holds the registry while it waits on the network.
pub(crate) struct SessionEntry {
    pub(crate) info: SessionInfo,
    pub(crate) write_half: Arc<tokio::sync::Mutex<russh::ChannelWriteHalf<Msg>>>,
    read_task: tauri::async_runtime::JoinHandle<()>,
}

impl std::fmt::Debug for SessionEntry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionEntry")
            .field("info", &self.info)
            .finish()
    }
}

/// Session registry shared with the reader task, which removes its own entry
/// when the channel closes.
pub(crate) type SessionRegistry = Arc<Mutex<HashMap<String, SessionEntry>>>;

/// Cap on one exec command's output; the metrics script emits a few kilobytes.
const EXEC_OUTPUT_LIMIT: usize = 256 * 1024;

/// One profile's SSH connection.
pub(crate) struct Connection {
    id: String,
    handle: tokio::sync::Mutex<russh::client::Handle<client::Client>>,
    /// Opened on first SFTP use and dropped with the connection.
    sftp: tokio::sync::Mutex<Option<Arc<SftpHandle>>>,
}

impl Connection {
    /// Run one command on a fresh exec channel of this connection.
    ///
    /// The handle lock only covers opening the channel; the command and its
    /// output are bounded by `timeout`, so a hung remote process cannot block
    /// the connection for other callers.
    pub(crate) async fn exec(&self, command: &str, timeout: Duration) -> ServerResult<String> {
        let channel = {
            let handle = self.handle.lock().await;
            match tokio::time::timeout(timeout, handle.channel_open_session()).await {
                Ok(Ok(channel)) => channel,
                Ok(Err(error)) => {
                    log::warn!("server_ssh_exec_channel_failed error={error}");
                    return Err(ServerError::internal(
                        "The command channel could not be opened.",
                    ));
                }
                Err(_) => return Err(ServerError::connect_timeout()),
            }
        };

        let collected = tokio::time::timeout(timeout, async move {
            let mut channel = channel;
            channel.exec(true, command.to_string()).await.map_err(|error| {
                log::warn!("server_ssh_exec_failed error={error}");
                ServerError::internal("The remote command could not be started.")
            })?;

            let mut output: Vec<u8> = Vec::new();
            while let Some(message) = channel.wait().await {
                match message {
                    russh::ChannelMsg::Data { data } => output.extend_from_slice(&data),
                    russh::ChannelMsg::ExtendedData { data, .. } => {
                        output.extend_from_slice(&data)
                    }
                    russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
                    _ => {}
                }
                if output.len() > EXEC_OUTPUT_LIMIT {
                    break;
                }
            }
            Ok::<Vec<u8>, ServerError>(output)
        })
        .await;

        match collected {
            Ok(Ok(output)) => Ok(String::from_utf8_lossy(&output).into_owned()),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(ServerError::internal("The remote command timed out.")),
        }
    }

    async fn is_alive(&self) -> bool {
        !self.handle.lock().await.is_closed()
    }

    async fn close(&self, profile_id: &str) {
        // The SFTP handle borrows this connection, so drop it first.
        let mut slot = self.sftp.lock().await;
        *slot = None;
        drop(slot);

        let handle = self.handle.lock().await;
        match tokio::time::timeout(
            session::DISCONNECT_TIMEOUT,
            handle.disconnect(russh::Disconnect::ByApplication, "", ""),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                log::warn!("server_ssh_disconnect_failed profile={profile_id} error={error}")
            }
            Err(_) => log::warn!("server_ssh_disconnect_timed_out profile={profile_id}"),
        }
    }
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Connection")
            .field("id", &self.id)
            .finish()
    }
}

/// Owns every live connection.
///
/// The pool is keyed by profile id: opening a second terminal on the same
/// profile reuses the connection and only adds a shell channel.
pub struct ConnectionManager {
    states: Mutex<HashMap<String, ConnectionState>>,
    connections: Mutex<HashMap<String, Arc<Connection>>>,
    sessions: SessionRegistry,
    /// One sampler per profile, started by the handshake that connected it.
    metrics: Mutex<HashMap<String, MetricsHandle>>,
    /// One async mutex per profile, so two simultaneous connects cannot each
    /// build a connection.
    connect_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Set by the command layer on the first connect; output events need it.
    app: OnceLock<tauri::AppHandle>,
}

impl Default for ConnectionManager {
    fn default() -> Self {
        Self {
            states: Mutex::new(HashMap::new()),
            connections: Mutex::new(HashMap::new()),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            metrics: Mutex::new(HashMap::new()),
            connect_locks: Mutex::new(HashMap::new()),
            app: OnceLock::new(),
        }
    }
}

impl std::fmt::Debug for ConnectionManager {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ConnectionManager")
            .field("states", &self.states)
            .field("connections", &self.connections)
            .finish()
    }
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Hand the manager the window handle it emits `server:*` events through.
    /// `ServerState::new` never sees it, so the command layer calls this
    /// before the first connect; later calls are no-ops.
    pub fn attach_app(&self, app: tauri::AppHandle) {
        let _ = self.app.set(app);
    }

    /// Open an interactive shell, connecting to the profile first if needed.
    ///
    /// `trust_host_key` is only honoured on first contact: an existing record
    /// whose fingerprint changed must fail with `host-key-mismatch` regardless.
    pub async fn connect_shell(
        &self,
        profile_id: &str,
        cols: u16,
        rows: u16,
        trust_host_key: bool,
    ) -> ServerResult<ConnectOutcome> {
        if profile_id.trim().is_empty() {
            return Err(ServerError::not_found(profile_id));
        }
        let profile = Store::open()?
            .profile(profile_id)?
            .ok_or_else(|| ServerError::not_found(profile_id))?;

        // Serialise connects per profile; a second shell on a warm connection
        // only needs the channel, so the wait is short.
        let connect_lock = self.connect_lock(profile_id);
        let _guard = connect_lock.lock().await;

        let (connection, reused) = self.ensure_connection(&profile, trust_host_key).await?;
        let (session_id, entry) = self.open_shell(&connection, &profile, cols, rows).await?;
        let outcome = ConnectOutcome {
            session_id: session_id.clone(),
            connection_id: connection.id.clone(),
            reused,
        };
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| ServerError::internal("The session registry is unavailable."))?;
        sessions.insert(session_id, entry);
        drop(sessions);
        self.set_state(profile_id, ConnectionState::Ready);
        Ok(outcome)
    }

    pub async fn write(&self, session_id: &str, data: &[u8]) -> ServerResult<()> {
        if data.is_empty() {
            return Ok(());
        }
        let Some(write_half) = self.write_half(session_id) else {
            return Err(ServerError::not_connected());
        };

        let writer = write_half.lock().await;
        let result =
            tokio::time::timeout(session::WRITE_TIMEOUT, writer.data_bytes(data.to_vec())).await;
        drop(writer);

        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => {
                log::warn!("server_ssh_write_failed session={session_id} error={error}");
                self.tear_down(session_id, "The terminal write failed.");
                Err(ServerError::not_connected())
            }
            Err(_) => {
                log::warn!("server_ssh_write_timed_out session={session_id}");
                self.tear_down(session_id, "The terminal write timed out.");
                Err(ServerError::not_connected())
            }
        }
    }

    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> ServerResult<()> {
        let Some(write_half) = self.write_half(session_id) else {
            return Err(ServerError::not_connected());
        };

        let writer = write_half.lock().await;
        let result = tokio::time::timeout(
            session::WRITE_TIMEOUT,
            writer.window_change(cols as u32, rows as u32, 0, 0),
        )
        .await;
        drop(writer);

        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => {
                log::warn!("server_ssh_resize_failed session={session_id} error={error}");
                Err(ServerError::not_connected())
            }
            Err(_) => Err(ServerError::internal("The terminal resize timed out.")),
        }
    }

    /// Close one shell channel; the connection stays up for other sessions.
    pub async fn disconnect(&self, session_id: &str) -> ServerResult<()> {
        let entry = self.take_session(session_id);
        let Some(entry) = entry else {
            return Err(ServerError::not_connected());
        };

        close_channel(session_id, entry.write_half.clone()).await;
        entry.read_task.abort();
        session::emit_exit(
            &self.app_handle(),
            session_id,
            Some("The session was closed.".to_string()),
        );
        Ok(())
    }

    /// Drop the connection and its SFTP subsystem for one profile.
    pub async fn close_profile(&self, profile_id: &str) -> ServerResult<()> {
        self.stop_metrics(profile_id);
        self.set_state(profile_id, ConnectionState::Idle);

        for (session_id, entry) in self.take_profile_sessions(profile_id) {
            close_channel(&session_id, entry.write_half.clone()).await;
            entry.read_task.abort();
            session::emit_exit(
                &self.app_handle(),
                &session_id,
                Some("The connection was closed.".to_string()),
            );
        }

        let connection = self
            .connections
            .lock()
            .ok()
            .and_then(|mut connections| connections.remove(profile_id));
        if let Some(connection) = connection {
            connection.close(profile_id).await;
        }
        Ok(())
    }

    /// Drop every connection. Called on app exit; never fails.
    pub async fn close_all(&self) {
        let ids: Vec<String> = match self.connections.lock() {
            Ok(connections) => connections.keys().cloned().collect(),
            Err(_) => Vec::new(),
        };
        for profile_id in ids {
            if let Err(error) = self.close_profile(&profile_id).await {
                log::warn!("server_ssh_close_all_failed profile={profile_id} error={error}");
            }
        }

        for (session_id, entry) in self.take_all_sessions() {
            entry.read_task.abort();
            let _ = session_id;
        }
    }

    /// The SFTP subsystem of a profile's connection, opened on first use.
    pub async fn sftp(&self, profile_id: &str) -> ServerResult<Arc<SftpHandle>> {
        let connection = self.connection(profile_id).ok_or_else(ServerError::not_connected)?;
        if !connection.is_alive().await {
            return Err(ServerError::not_connected());
        }

        let mut slot = connection.sftp.lock().await;
        if let Some(handle) = slot.as_ref() {
            return Ok(handle.clone());
        }

        let channel = {
            let handle = connection.handle.lock().await;
            tokio::time::timeout(session::CONNECT_TIMEOUT, handle.channel_open_session())
                .await
                .map_err(|_| ServerError::connect_timeout())?
                .map_err(|error| {
                    log::warn!("server_sftp_channel_failed profile={profile_id} error={error}");
                    ServerError::internal("The SFTP channel could not be opened.")
                })?
        };
        let handle = Arc::new(SftpHandle::new(profile_id, channel).await?);
        *slot = Some(handle.clone());
        Ok(handle)
    }

    /// Current state of a profile; unknown profiles read as `Idle`.
    pub fn state(&self, profile_id: &str) -> ConnectionState {
        self.states
            .lock()
            .ok()
            .and_then(|states| states.get(profile_id).copied())
            .unwrap_or(ConnectionState::Idle)
    }

    /// Every live shell, for diagnostics and cleanup.
    pub fn sessions(&self) -> Vec<SessionInfo> {
        self.sessions
            .lock()
            .map(|sessions| {
                sessions
                    .values()
                    .map(|entry| entry.info.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Record a profile's state. Used by the implementation as it connects.
    pub(crate) fn set_state(&self, profile_id: &str, state: ConnectionState) {
        if let Ok(mut states) = self.states.lock() {
            states.insert(profile_id.to_string(), state);
        }
    }

    fn app_handle(&self) -> Option<tauri::AppHandle> {
        self.app.get().cloned()
    }

    /// Start the profile's metrics sampler unless one is already running.
    fn start_metrics(&self, profile_id: &str, connection: Arc<Connection>) {
        let mut metrics = match self.metrics.lock() {
            Ok(metrics) => metrics,
            Err(poisoned) => poisoned.into_inner(),
        };
        if metrics.contains_key(profile_id) {
            return;
        }
        metrics.insert(
            profile_id.to_string(),
            monitor::spawn_sampler(self.app_handle(), profile_id.to_string(), connection),
        );
    }

    /// Stop the profile's sampler and drop its history.
    fn stop_metrics(&self, profile_id: &str) {
        let handle = self
            .metrics
            .lock()
            .ok()
            .and_then(|mut metrics| metrics.remove(profile_id));
        if let Some(handle) = handle {
            handle.task.abort();
        }
    }

    /// Buffered samples of one profile, oldest first.
    pub fn metrics_history(&self, profile_id: &str) -> Vec<MetricsSample> {
        let Ok(metrics) = self.metrics.lock() else {
            return Vec::new();
        };
        let Some(samples) = metrics.get(profile_id).map(|handle| handle.samples.clone()) else {
            return Vec::new();
        };
        drop(metrics);

        let history: Vec<MetricsSample> = match samples.lock() {
            Ok(samples) => samples.iter().cloned().collect(),
            Err(_) => Vec::new(),
        };
        history
    }

    fn connection(&self, profile_id: &str) -> Option<Arc<Connection>> {
        self.connections
            .lock()
            .ok()
            .and_then(|connections| connections.get(profile_id).cloned())
    }

    fn write_half(&self, session_id: &str) -> Option<Arc<tokio::sync::Mutex<russh::ChannelWriteHalf<Msg>>>> {
        self.sessions
            .lock()
            .ok()
            .and_then(|sessions| sessions.get(session_id).map(|entry| entry.write_half.clone()))
    }

    fn take_session(&self, session_id: &str) -> Option<SessionEntry> {
        self.sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(session_id))
    }

    fn take_profile_sessions(&self, profile_id: &str) -> Vec<(String, SessionEntry)> {
        let Ok(mut sessions) = self.sessions.lock() else {
            return Vec::new();
        };
        let ids: Vec<String> = sessions
            .iter()
            .filter(|(_, entry)| entry.info.profile_id == profile_id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| sessions.remove(&id).map(|entry| (id, entry)))
            .collect()
    }

    fn take_all_sessions(&self) -> Vec<(String, SessionEntry)> {
        match self.sessions.lock() {
            Ok(mut sessions) => sessions.drain().collect(),
            Err(_) => Vec::new(),
        }
    }

    fn connect_lock(&self, profile_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self
            .connect_locks
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks
            .entry(profile_id.to_string())
            .or_default()
            .clone()
    }

    /// Tear a session down after a failed write, so the actor does not linger.
    fn tear_down(&self, session_id: &str, reason: &str) {
        if let Some(entry) = self.take_session(session_id) {
            entry.read_task.abort();
            session::emit_exit(&self.app_handle(), session_id, Some(reason.to_string()));
        }
    }

    /// The pool entry for a profile, connecting when there is none or it died.
    async fn ensure_connection(
        &self,
        profile: &ServerProfile,
        trust_host_key: bool,
    ) -> ServerResult<(Arc<Connection>, bool)> {
        if let Some(existing) = self.connection(&profile.id) {
            if existing.is_alive().await {
                return Ok((existing, true));
            }
            log::info!("server_ssh_connection_stale profile={}", profile.id);
            self.close_profile(&profile.id).await?;
        }

        let connection = self.open_connection(profile, trust_host_key).await?;
        Ok((connection, false))
    }

    async fn open_connection(
        &self,
        profile: &ServerProfile,
        trust_host_key: bool,
    ) -> ServerResult<Arc<Connection>> {
        self.set_state(&profile.id, ConnectionState::Connecting);
        match self.handshake(profile, trust_host_key).await {
            Ok(connection) => {
                self.set_state(&profile.id, ConnectionState::Ready);
                Ok(connection)
            }
            Err(error) => {
                self.set_state(&profile.id, ConnectionState::Failed);
                Err(error)
            }
        }
    }

    async fn handshake(
        &self,
        profile: &ServerProfile,
        trust_host_key: bool,
    ) -> ServerResult<Arc<Connection>> {
        let record = host_keys::get(&profile.id)?;
        let probe = Arc::new(HostKeyProbe::new());

        let mut config = russh::client::Config::default();
        config.keepalive_interval = Some(session::KEEPALIVE_INTERVAL);
        config.keepalive_max = 3;
        config.nodelay = true;
        let config = Arc::new(config);

        let handler = client::Client::new(probe.clone(), record, trust_host_key);
        let connected = tokio::time::timeout(
            session::CONNECT_TIMEOUT,
            russh::client::connect(config, (profile.host.as_str(), profile.port), handler),
        )
        .await;

        let mut handle = match connected {
            Ok(Ok(handle)) => handle,
            Ok(Err(error)) => {
                return Err(self.map_connect_error(profile, probe.take(), &error));
            }
            Err(_) => {
                host_keys::clear_pending(&profile.id);
                log::warn!(
                    "server_ssh_connect_timed_out host={} port={}",
                    profile.host,
                    profile.port
                );
                return Err(ServerError::connect_timeout());
            }
        };

        let presented = probe.take();
        if let Err(error) = auth::authenticate(&mut handle, profile).await {
            host_keys::clear_pending(&profile.id);
            return Err(error);
        }

        // First contact: the caller said `trustHostKey`, so persist the key
        // only now that authentication succeeded.
        if let Some(presented) = presented.as_ref() {
            if matches!(presented.verdict, HostKeyVerdict::Unknown) {
                host_keys::record_trusted(
                    &profile.id,
                    &presented.algorithm,
                    &profile.host,
                    profile.port,
                    &presented.fingerprint,
                )?;
            }
        }

        let connection = Arc::new(Connection {
            id: client::new_connection_id(),
            handle: tokio::sync::Mutex::new(handle),
            sftp: tokio::sync::Mutex::new(None),
        });
        if let Ok(mut connections) = self.connections.lock() {
            connections.insert(profile.id.clone(), connection.clone());
        }
        // Collection starts as soon as the connection is usable, whether or
        // not the window has opened the monitor tab.
        self.start_metrics(&profile.id, connection.clone());
        if let Err(error) = Store::open().and_then(|store| {
            store.touch_connected(&profile.id, unix_now())
        }) {
            log::warn!("server_ssh_touch_profile_failed profile={} error={error}", profile.id);
        }
        log::info!(
            "server_ssh_connected profile={} host={} port={} connection={}",
            profile.id,
            profile.host,
            profile.port,
            connection.id
        );
        Ok(connection)
    }

    fn map_connect_error(
        &self,
        profile: &ServerProfile,
        presented: Option<PresentedHostKey>,
        error: &russh::Error,
    ) -> ServerError {
        match presented {
            Some(presented) => match presented.verdict {
                HostKeyVerdict::Unknown => {
                    host_keys::remember_pending(
                        &profile.id,
                        &presented.fingerprint,
                        &presented.algorithm,
                        &profile.host,
                        profile.port,
                    );
                    ServerError::host_key_unknown(&presented.fingerprint, &presented.algorithm)
                }
                HostKeyVerdict::Mismatch {
                    trusted,
                    presented: shown,
                } => ServerError::host_key_mismatch(&trusted, &shown),
                HostKeyVerdict::Trusted => {
                    log::warn!(
                        "server_ssh_handshake_failed host={} port={} error={error}",
                        profile.host,
                        profile.port
                    );
                    ServerError::internal("The SSH handshake failed.")
                }
            },
            None => {
                log::warn!(
                    "server_ssh_connect_failed host={} port={} error={error}",
                    profile.host,
                    profile.port
                );
                ServerError::internal("The SSH connection could not be established.")
            }
        }
    }

    /// Open one shell channel on an established connection.
    async fn open_shell(
        &self,
        connection: &Arc<Connection>,
        profile: &ServerProfile,
        cols: u16,
        rows: u16,
    ) -> ServerResult<(String, SessionEntry)> {
        let terminal = if profile.terminal_type.trim().is_empty() {
            store::DEFAULT_TERMINAL_TYPE
        } else {
            profile.terminal_type.as_str()
        };

        let channel = {
            let handle = connection.handle.lock().await;
            tokio::time::timeout(
                session::CONNECT_TIMEOUT,
                handle.channel_open_session(),
            )
            .await
            .map_err(|_| ServerError::connect_timeout())?
            .map_err(|error| {
                log::warn!("server_ssh_channel_open_failed error={error}");
                ServerError::internal("The shell channel could not be opened.")
            })?
        };

        tokio::time::timeout(
            session::CONNECT_TIMEOUT,
            channel.request_pty(true, terminal, cols as u32, rows as u32, 0, 0, &[]),
        )
        .await
        .map_err(|_| ServerError::connect_timeout())?
        .map_err(|error| {
            log::warn!("server_ssh_pty_failed error={error}");
            ServerError::internal("The terminal could not be created.")
        })?;

        tokio::time::timeout(session::CONNECT_TIMEOUT, channel.request_shell(true))
            .await
            .map_err(|_| ServerError::connect_timeout())?
            .map_err(|error| {
                log::warn!("server_ssh_shell_failed error={error}");
                ServerError::internal("The shell could not be started.")
            })?;

        let session_id = uuid::Uuid::new_v4().to_string();
        let (read_half, write_half) = channel.split();
        let info = SessionInfo {
            session_id: session_id.clone(),
            profile_id: profile.id.clone(),
            cols,
            rows,
            started_at: unix_now(),
        };
        let read_task = session::spawn_reader(
            self.app_handle(),
            session_id.clone(),
            read_half,
            self.sessions.clone(),
        );
        let entry = SessionEntry {
            info,
            write_half: Arc::new(tokio::sync::Mutex::new(write_half)),
            read_task,
        };
        Ok((session_id, entry))
    }
}

/// Close one channel, bounded so a dead peer cannot hang the caller.
async fn close_channel(
    session_id: &str,
    write_half: Arc<tokio::sync::Mutex<russh::ChannelWriteHalf<Msg>>>,
) {
    let closed = tokio::time::timeout(session::DISCONNECT_TIMEOUT, async move {
        let writer = write_half.lock().await;
        writer.close().await
    })
    .await;

    match closed {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            log::debug!("server_ssh_session_close_failed session={session_id} error={error}")
        }
        Err(_) => log::warn!("server_ssh_session_close_timed_out session={session_id}"),
    }
}

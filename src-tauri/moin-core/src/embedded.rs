// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `UPSTREAM.md` for the porting record.

//! The built-in transfer backend: a `reqwest` client and nothing else.
//!
//! It owns no session and no child process, so `shutdown` has nothing to do and
//! `reconfigure` only rebuilds the client when the connect timeout changes.
//! Everything a transfer needs lives in [`crate::http`].

use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use reqwest::Client;

use crate::backend::{Control, DownloadBackend, NetConfig, Outcome, ProgressFn, TransferOpts};
use crate::http;
use crate::models::{Task, TaskKind};

pub struct EmbeddedBackend {
    /// The client is immutable once built; `reconfigure` swaps the whole value.
    client: Mutex<Client>,
}

impl EmbeddedBackend {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(build_client(None)),
        }
    }

    /// A clone is cheap and keeps the lock out of every `.await`.
    fn client(&self) -> Client {
        self.client
            .lock()
            .map(|client| client.clone())
            .unwrap_or_else(|_| build_client(None))
    }
}

impl Default for EmbeddedBackend {
    fn default() -> Self {
        Self::new()
    }
}

fn build_client(connect_timeout: Option<Duration>) -> Client {
    let mut builder = Client::builder();
    if let Some(timeout) = connect_timeout.filter(|timeout| !timeout.is_zero()) {
        builder = builder.connect_timeout(timeout);
    }
    builder.build().unwrap_or_default()
}

#[async_trait]
impl DownloadBackend for EmbeddedBackend {
    fn id(&self) -> &'static str {
        "embedded"
    }

    fn label(&self) -> &'static str {
        "Built-in"
    }

    fn supports(&self, kind: TaskKind) -> bool {
        matches!(kind, TaskKind::Http)
    }

    fn reconfigure(&self, net: NetConfig) {
        if let Ok(mut client) = self.client.lock() {
            *client = build_client(net.connect_timeout);
        }
    }

    async fn run(
        &self,
        task: Task,
        opts: TransferOpts,
        control: Control,
        progress: ProgressFn,
    ) -> Outcome {
        if !self.supports(task.kind) {
            return Outcome::Failed("the built-in backend can't handle this source".to_string());
        }
        let client = self.client();
        let headers = http::build_headers(&task.headers);
        http::download(
            &client,
            &task.url,
            &headers,
            &task.part_path(),
            &task.dest,
            &task.meta_path(),
            opts.connections,
            opts.min_split_size,
            opts.hide_part,
            opts.stall_timeout,
            &control,
            &progress,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::EmbeddedBackend;
    use crate::backend::{Control, DownloadBackend, Outcome, TransferOpts};
    use crate::models::{Task, TaskKind, TaskStatus};
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use std::time::Duration;

    fn task(kind: TaskKind) -> Task {
        Task {
            id: "task".to_string(),
            kind,
            url: "http://127.0.0.1:1/file.bin".to_string(),
            filename: "file.bin".to_string(),
            dest: "file.bin".to_string(),
            status: TaskStatus::Queued,
            total: None,
            received: 0,
            error: None,
            created_at: 0,
            updated_at: 0,
            completed_at: None,
            archived: false,
            active_ms: 0,
            backend: None,
            category: None,
            final_dir: None,
            headers: BTreeMap::new(),
        }
    }

    #[test]
    fn advertises_the_frozen_identity() {
        let backend = EmbeddedBackend::new();
        assert_eq!(backend.id(), "embedded");
        assert_eq!(backend.label(), "Built-in");
        assert!(backend.supports(TaskKind::Http));
        assert!(!backend.supports(TaskKind::Media));
        assert!(backend.available());
    }

    #[tokio::test]
    async fn refuses_sources_it_cannot_transfer() {
        let backend = EmbeddedBackend::new();
        let outcome = backend
            .run(
                task(TaskKind::Media),
                TransferOpts {
                    connections: 1,
                    min_split_size: 1024,
                    hide_part: false,
                    stall_timeout: Duration::from_secs(1),
                },
                Control::new(),
                Arc::new(|_, _| {}),
            )
            .await;
        match outcome {
            Outcome::Failed(message) => {
                assert_eq!(message, "the built-in backend can't handle this source")
            }
            other => panic!("expected a readable failure, got {other:?}"),
        }
    }
}

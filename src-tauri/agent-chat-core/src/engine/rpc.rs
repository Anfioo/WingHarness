//! JSON-RPC line framing shared by the Codex app-server and ACP drivers.
//!
//! Adapted from desktop-cc-gui (MIT), https://github.com/zhukunpenglinyutong/desktop-cc-gui.
//! Copyright (c) 2026 zhukunpenglinyutong
//! Licensed under the MIT License. See licenses/desktop-cc-gui-LICENSE.txt.
//!
//! Both drivers speak newline-delimited JSON-RPC on the CLI's stdio. The CLI
//! also prints human-readable banners and debug lines on the same stdout, so
//! the reader skips anything that is not a complete JSON frame instead of
//! failing the turn.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::Mutex;

use crate::AgentChatError;

pub const JSON_RPC_VERSION: &str = "2.0";

/// Request ids are unique within the process; the drivers only need them to be
/// distinct, so a relaxed counter is enough.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// One JSON-RPC channel: stdin is shared with the answer command (a parked
/// question's response is written on the same pipe), stdout is owned by the
/// driver's pump.
pub struct LineRpc {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    stdout: BufReader<ChildStdout>,
    line: String,
}

impl LineRpc {
    pub fn new(
        stdin: Arc<Mutex<Option<ChildStdin>>>,
        stdout: ChildStdout,
    ) -> Self {
        Self {
            stdin,
            stdout: BufReader::new(stdout),
            line: String::new(),
        }
    }

    /// Reads the next JSON frame. `Ok(None)` means the peer closed stdout.
    pub async fn read_line(&mut self) -> Result<Option<Value>, AgentChatError> {
        read_json_line(&mut self.stdout, &mut self.line).await
    }

    /// Writes one frame as a single line and flushes it.
    pub async fn write(&self, value: &Value) -> Result<(), AgentChatError> {
        let bytes = frame_bytes(value)?;
        let mut guard = self.stdin.lock().await;
        let Some(stdin) = guard.as_mut() else {
            return Err(AgentChatError::internal(
                "The JSON-RPC stdin is already closed.",
            ));
        };
        stdin
            .write_all(&bytes)
            .await
            .map_err(|error| AgentChatError::internal(format!("Writing a JSON-RPC frame failed: {error}")))?;
        stdin
            .flush()
            .await
            .map_err(|error| AgentChatError::internal(format!("Flushing a JSON-RPC frame failed: {error}")))
    }

    /// Fresh request id for a `request`/`response` exchange.
    pub fn next_id() -> u64 {
        NEXT_ID.fetch_add(1, Ordering::Relaxed)
    }
}

/// Serializes one frame with its trailing newline.
fn frame_bytes(value: &Value) -> Result<Vec<u8>, AgentChatError> {
    let mut bytes = serde_json::to_vec(value)
        .map_err(|error| AgentChatError::internal(format!("Serializing a JSON-RPC frame failed: {error}")))?;
    bytes.push(b'\n');
    Ok(bytes)
}

/// Reads until a complete JSON value is parsed. Blank and non-JSON lines are
/// consumed and skipped: CLIs mix banners and debug output into stdout.
async fn read_json_line<R>(
    reader: &mut R,
    line: &mut String,
) -> Result<Option<Value>, AgentChatError>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        line.clear();
        let read = reader
            .read_line(line)
            .await
            .map_err(|error| AgentChatError::internal(format!("Reading a JSON-RPC line failed: {error}")))?;
        if read == 0 {
            return Ok(None);
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(value) => return Ok(Some(value)),
            Err(_) => continue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn reader_for(payload: &str) -> BufReader<tokio::io::DuplexStream> {
        let (mut writer, reader) = tokio::io::duplex(payload.len() + 16);
        writer
            .write_all(payload.as_bytes())
            .await
            .expect("write fixture");
        drop(writer);
        BufReader::new(reader)
    }

    #[tokio::test]
    async fn skips_banners_and_blank_lines_before_a_frame() {
        let mut reader = reader_for(
            "codex app-server starting\n\nnot json at all\n{\"jsonrpc\":\"2.0\",\"id\":7}\n",
        )
        .await;
        let mut line = String::new();
        let value = read_json_line(&mut reader, &mut line)
            .await
            .expect("read")
            .expect("frame");
        assert_eq!(value["id"], 7);

        let eof = read_json_line(&mut reader, &mut line)
            .await
            .expect("read past the end");
        assert!(eof.is_none());
    }

    #[tokio::test]
    async fn eof_without_any_frame_is_none() {
        let mut reader = reader_for("").await;
        let mut line = String::new();
        assert!(read_json_line(&mut reader, &mut line)
            .await
            .expect("read")
            .is_none());
    }

    #[test]
    fn frames_are_one_line_with_a_trailing_newline() {
        let bytes = frame_bytes(&json!({ "jsonrpc": "2.0", "method": "initialize" }))
            .expect("serialize");
        assert_eq!(bytes.last(), Some(&b'\n'));
        let text = std::str::from_utf8(&bytes).expect("utf8");
        assert_eq!(text.matches('\n').count(), 1);
        assert!(text.ends_with('\n'));
    }

    #[test]
    fn ids_never_repeat() {
        let first = LineRpc::next_id();
        let second = LineRpc::next_id();
        assert!(second > first);
    }
}

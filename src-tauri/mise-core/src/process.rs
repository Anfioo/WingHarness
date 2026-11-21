// Adapted from mise_gui (https://github.com/likaia/mise_gui), MIT License.
// See ../UPSTREAM.md for the porting record.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::{MiseError, MiseResult};
use crate::models::{MiseCommandResult, MiseOutputChunk};

/// Resolve the mise executable. The search order is `MISE_EXECUTABLE`, `PATH`,
/// the app's own Scoop shims, then the usual per-user install locations.
pub fn resolve_executable() -> MiseResult<PathBuf> {
    Err(MiseError::not_implemented())
}

/// The first candidate that exists, used by the probe and by tests.
pub fn resolve_executable_from(_candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    None
}

/// Decode console output: strict UTF-8 first, then GBK, then lossy.
pub fn decode_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Run one `mise` invocation without a shell, streaming output when a sender is
/// provided. Cancellation and timeouts kill the child first.
#[allow(clippy::too_many_arguments)]
pub async fn run_command(
    _args: &[String],
    _working_directory: Option<&Path>,
    _timeout: Duration,
    _allow_non_zero: bool,
    _cancel: Option<tokio_util::sync::CancellationToken>,
    _on_output: Option<tokio::sync::mpsc::UnboundedSender<MiseOutputChunk>>,
) -> MiseResult<MiseCommandResult> {
    Err(MiseError::not_implemented())
}

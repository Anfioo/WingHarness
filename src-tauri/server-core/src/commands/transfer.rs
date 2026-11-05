//! Transfer queue commands. The queue itself lives in `sftp::transfer` so it
//! survives the window being closed and reopened.

use crate::error::ServerResult;
use crate::models::{ConflictPolicy, TransferDirection, TransferSnapshot};
use crate::sftp::transfer;
use crate::ServerState;

pub(crate) async fn start(
    state: &ServerState,
    profile_id: &str,
    direction: TransferDirection,
    sources: Vec<String>,
    target_dir: &str,
    conflict_policy: ConflictPolicy,
) -> ServerResult<Vec<String>> {
    transfer::start(
        state,
        profile_id,
        direction,
        sources,
        target_dir,
        conflict_policy,
    )
    .await
}

pub(crate) async fn pause(transfer_id: &str) -> ServerResult<()> {
    transfer::pause(transfer_id).await
}

pub(crate) async fn resume(state: &ServerState, transfer_id: &str) -> ServerResult<()> {
    transfer::resume(state, transfer_id).await
}

pub(crate) async fn cancel(transfer_id: &str) -> ServerResult<()> {
    transfer::cancel(transfer_id).await
}

pub(crate) fn list() -> ServerResult<Vec<TransferSnapshot>> {
    transfer::list()
}

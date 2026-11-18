// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! Account CRUD, folder selection and the connection test.
//!
//! A0 placeholder: B1 implements these against the store and the B2 transport.

use sqlx::SqlitePool;

use crate::error::{OneMailError, OneMailResult};
use crate::models::{
    AccountInput, AccountSummary, AccountTestInput, AccountUpdateInput, ConnectionTestResult,
    FolderCandidate, FolderDiscoveryInput, MailFolder,
};
use crate::state::OneMailState;

pub async fn list(_pool: &SqlitePool) -> OneMailResult<Vec<AccountSummary>> {
    Err(OneMailError::not_implemented())
}

pub async fn create(_pool: &SqlitePool, _input: AccountInput) -> OneMailResult<AccountSummary> {
    Err(OneMailError::not_implemented())
}

pub async fn update(
    _pool: &SqlitePool,
    _input: AccountUpdateInput,
) -> OneMailResult<AccountSummary> {
    Err(OneMailError::not_implemented())
}

pub async fn remove(_pool: &SqlitePool, _account_id: i64) -> OneMailResult<bool> {
    Err(OneMailError::not_implemented())
}

pub async fn test_connection(
    _state: &OneMailState,
    _input: AccountTestInput,
) -> OneMailResult<ConnectionTestResult> {
    Err(OneMailError::not_implemented())
}

pub async fn discover_folders(
    _state: &OneMailState,
    _input: FolderDiscoveryInput,
) -> OneMailResult<Vec<FolderCandidate>> {
    Err(OneMailError::not_implemented())
}

pub async fn list_folders(_pool: &SqlitePool, _account_id: i64) -> OneMailResult<Vec<MailFolder>> {
    Err(OneMailError::not_implemented())
}

pub async fn set_folder_sync(
    _pool: &SqlitePool,
    _account_id: i64,
    _folder_ids: Vec<i64>,
) -> OneMailResult<Vec<MailFolder>> {
    Err(OneMailError::not_implemented())
}

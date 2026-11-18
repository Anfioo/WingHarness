// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! IMAP connection, authentication and raw-message retrieval.
//!
//! A0 placeholder: B2 implements this file with `async-imap` 0.11 and
//! `async-native-tls` 0.6, keeping the password out of every error detail.

use crate::error::{OneMailError, OneMailResult};
use crate::models::{
    AccountTestInput, ConnectionTestResult, FolderCandidate, FolderDiscoveryInput,
};
use crate::state::OneMailState;

pub async fn test_connection(_input: &AccountTestInput) -> OneMailResult<ConnectionTestResult> {
    Err(OneMailError::not_implemented())
}

pub async fn discover_folders(
    _input: &FolderDiscoveryInput,
) -> OneMailResult<Vec<FolderCandidate>> {
    Err(OneMailError::not_implemented())
}

pub async fn fetch_raw_message(
    _state: &OneMailState,
    _account_id: i64,
    _folder_path: &str,
    _uid: u32,
) -> OneMailResult<Vec<u8>> {
    Err(OneMailError::not_implemented())
}

pub async fn append_to_sent(
    _state: &OneMailState,
    _account_id: i64,
    _raw: &[u8],
) -> OneMailResult<()> {
    Err(OneMailError::not_implemented())
}

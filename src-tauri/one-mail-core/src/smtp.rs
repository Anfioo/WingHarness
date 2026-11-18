// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! Message assembly and sending through `lettre`.
//!
//! A0 placeholder: B2 implements this file, including the optional APPEND to
//! the Sent folder and the `warning` on a successful send whose APPEND failed.

use crate::error::{OneMailError, OneMailResult};
use crate::models::{SendInput, SendResult};
use crate::state::OneMailState;

pub async fn send(
    _state: &OneMailState,
    _account_id: i64,
    _input: &SendInput,
) -> OneMailResult<SendResult> {
    Err(OneMailError::not_implemented())
}

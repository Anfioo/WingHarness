// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! MIME parsing with `mailparse`: headers, body parts, attachments and
//! participants.
//!
//! A0 placeholder: B2 implements this file and defines the fields of
//! `ParsedMessage`. B3 does not call it.

use crate::error::{OneMailError, OneMailResult};

/// The result of parsing one raw message. B2 defines its fields.
#[derive(Debug, Clone, Default)]
pub struct ParsedMessage;

pub fn parse(_raw: &[u8]) -> OneMailResult<ParsedMessage> {
    Err(OneMailError::not_implemented())
}

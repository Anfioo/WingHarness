// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! The global `settings.json` document under `<data dir>/one-mail`.
//!
//! A0 placeholder: B1 implements the atomic read/write and the range checks
//! (`refreshIntervalMinutes` 1–1440, `syncWindowDays` 1–3650).

use crate::error::{OneMailError, OneMailResult};
use crate::models::OneMailSettings;

pub fn read() -> OneMailResult<OneMailSettings> {
    Err(OneMailError::not_implemented())
}

pub fn write(_settings: &OneMailSettings) -> OneMailResult<OneMailSettings> {
    Err(OneMailError::not_implemented())
}

pub fn validate(_settings: &OneMailSettings) -> OneMailResult<()> {
    Err(OneMailError::not_implemented())
}

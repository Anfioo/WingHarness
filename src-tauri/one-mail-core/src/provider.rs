// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `UPSTREAM.md` in this crate for the porting record.

//! The built-in provider presets (20 providers plus a custom IMAP fallback).
//!
//! A0 placeholder: the table is empty and B1 fills it from a static table. The
//! two entry points are frozen.

use crate::models::ProviderPreset;

/// Every built-in provider preset, in display order.
pub fn presets() -> &'static [ProviderPreset] {
    &[]
}

/// Look a preset up by its stable key; `None` falls back to the custom form.
pub fn find(_key: &str) -> Option<&'static ProviderPreset> {
    None
}

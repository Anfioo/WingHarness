# Origin: systools-core

Derived from [MangoDisk](https://github.com/harry0703/MangoDisk), a Windows
system-maintenance utility.

- Upstream version at import: **1.2.2**
- Upstream commit: **1497794** (2026-11-01)
- License: GPL-3.0-only — Copyright (c) the MangoDisk contributors. The full
  text is this repository's `LICENSE`.
- Imported subtrees: the system-tools engine and the systools pages.

## Status

Ten files were byte-identical at import. The crate and its pages are now
maintained here; they are the reason WingHarness as a whole is GPL-3.0-only.

## Divergences at import

- Windows only: the macOS and Linux code paths were not carried over.
- Disk analysis, duplicate/large-file cleanup, startup items, application
  uninstall and system settings were kept; unrelated MangoDisk features were
  not.
- The frontend is a React rewrite for this app's shell, not a copy of
  MangoDisk's Vue pages.

## Taking an upstream change

1. Diff this crate against MangoDisk's corresponding engine and pages.
2. Apply the change by hand on top of the local edits.
3. `cargo test -p systools-core` and smoke-test the systools pages.

# Origin: server-core

Adapted from [XTerm](https://github.com/Rockytkg/XTerm).

- Upstream version at import: **1.0.6**
- Upstream commit: **3a67961** (2026-11-01)
- License: MIT — Copyright (c) 2026 Rockytkg. The full text is in
  `licenses/XTerm-LICENSE.txt`.
- Imported portions: the `russh` / `russh-sftp` usage, host-key fingerprinting
  (ring SHA-256, unpadded base64, `SHA256:` prefix) and connection timeouts.

## Status

A trimmed rewrite, not a copy — no file is byte-identical. The crate is
first-party code maintained here.

## Divergences at import

- XTerm's Vue frontend was not copied; the UI is this app's React pages.
- The SSH connection pool, interactive shell sessions, SFTP operations and the
  transfer queue are organised around this app's Tauri command surface.
- Credentials are stored per this app's server store; the OS keychain is read
  only for the one-shot v1 migration.

## Taking an upstream change

1. Diff the relevant XTerm module against this crate.
2. Apply the change by hand on top of the local edits.
3. `cargo test -p server-core` and smoke-test the server manager window.

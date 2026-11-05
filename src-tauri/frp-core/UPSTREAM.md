# Origin: frp-core

Adapted from [Frpilot](https://github.com/leapfu/frpilot).

- Upstream version at import: **1.0.0**
- Upstream commit: **5f93f1f** (2026-08-20)
- License: MIT — Copyright (c) 2026 Frpilot contributors. The full text is in
  `licenses/Frpilot-LICENSE.txt`.
- Imported portions: the frpc process manager, TOML generator, runtime
  discovery and log handling.

## Status

Rewritten rather than copied — no file is byte-identical. The crate is
first-party code maintained here.

## Divergences at import

- SQLite persistence, keyring credential storage and the official runtime
  downloader from the upstream project were not ported.
- Profiles, tunnels and runtimes are stored as JSON in this app's config
  directory.
- `frpc.toml` is generated from the structured form with the workspace's own
  `toml` version.

## Taking an upstream change

1. Diff the relevant Frpilot module against this crate.
2. Apply the change by hand on top of the local edits.
3. `cargo test -p frp-core` and smoke-test the FRP console.

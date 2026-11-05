# Origin: shaic-core

Derived from the `core/` crate of [dariocurr/shaic](https://github.com/dariocurr/shaic),
so the AI config-sync feature builds on that store / adapter / materialize logic
instead of reimplementing it.

- Upstream version at import: **v0.3.0** (workspace `version = "0.3.0"`)
- Upstream commit: see the `.dev/shaic` checkout at import time
- License: MIT — the notice is retained even though this copy is maintained here.
  The full text is in `licenses/shaic-LICENSE.txt`.

## Status

`src/` and `tests/` were byte-for-byte identical to upstream at import. This is
no longer true: the crate is now a first-party engine of this app and is edited
here as the feature needs it. **Do not re-sync by copying upstream over this
directory** — it would drop those edits.

## Manifest

Upstream inherits from its own workspace (`version.workspace = true`,
`edition.workspace = true`, …); those keys and the dependency versions are
inlined as literals here. `edition = "2024"` and `rust-version = "1.85"` are kept
from upstream because the source is written for them — unlike the sibling engine
crates, which are edition 2021.

## Taking an upstream change

1. Diff this crate against the upstream `core/` to isolate the change.
2. Apply it by hand on top of the local edits.
3. `cargo test -p shaic-core` and smoke-test the AI config page.
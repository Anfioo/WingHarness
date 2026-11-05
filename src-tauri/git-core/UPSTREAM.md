# Origin: git-core

Adapted from [angkorgit](https://github.com/cheat2001/angkorgit), the reference
application this repository's Git engine was first ported from.

- Upstream version at import: **0.23.0**
- Upstream commit: **abfc66e** (2026-10-13)
- License: MIT — Copyright (c) 2026 Chansocheat Sok and AngKorGit contributors.
  The full text is in `licenses/AngKorGit-LICENSE.txt`.
- Imported subtree: `apps/desktop/src-tauri/src`

## Status

Sixteen files were byte-identical at import. The crate has been edited here
since, so it is now first-party code; the remaining identical files are
incidental. Do not re-sync by copying upstream over this directory — it would
drop the local changes.

## Divergences at import

- Only the Git engine was carried over; angkorgit's other desktop crates and
  its frontend were not.
- Paths, command names and error strings follow this app's conventions rather
  than angkorgit's.

## Taking an upstream change

1. Diff this crate against angkorgit's `apps/desktop/src-tauri/src`.
2. Apply the change by hand on top of the local edits.
3. `cargo test -p git-core` and smoke-test the Git repository window.

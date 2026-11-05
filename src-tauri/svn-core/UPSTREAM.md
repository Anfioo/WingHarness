# Origin: svn-core

Ported wholesale from [OrcaSVN](https://github.com/wustites/OrcaSVN).

- Upstream version at import: not recorded — the upstream checkout was not kept
  with this repository.
- License: MIT — Copyright (c) 2026 VoidOrca. The full text is in
  `licenses/OrcaSVN-LICENSE.txt`.
- Imported subtree: the crate's source and the SVN workspace pages.

## Status

The crate — an engine that spawns the local `svn` executable and parses its XML
and text output — was carried over whole and is maintained here. Do not re-sync
by copying upstream over this directory.

## Divergences at import

- The frontend was adapted rather than copied; page state, dialogs and styling
  follow this app's React/Tailwind conventions.
- Workspace storage uses this app's config directory.

## Taking an upstream change

1. Diff this crate against OrcaSVN's SVN engine sources.
2. Apply the change by hand on top of the local edits.
3. `cargo test -p svn-core` and smoke-test the SVN workspace window.

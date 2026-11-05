# Third-Party Licenses

The **关于** (About) window has a **Third-party licenses** button. It opens a
dialog that lists the projects ported into WingHarness and shows the full
third-party notices, so the licence information is readable without leaving the
app or going online.

## What the dialog shows

- **Source projects** — one row per upstream: name, licence badge, the module
  that carries the ported code, and a button that opens the upstream repository
  in the system browser.
- **Full notices** — the complete `THIRD_PARTY_NOTICES` file for the current
  language, in a scrollable pane.
- The application's own licence, GPL-3.0-only, is stated in the header.

## Where the content comes from

| Piece | Source |
|-------|--------|
| Upstream list | `UPSTREAMS` in [`src/windows/about/index.tsx`](../../src/windows/about/index.tsx) |
| Notices text | [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) and [`THIRD_PARTY_NOTICES.zh-CN.md`](../../THIRD_PARTY_NOTICES.zh-CN.md), imported with Vite's `?raw` |
| Licence texts | [`licenses/`](../../licenses/) |

The notices are embedded at build time, so the dialog works offline and needs no
Tauri command or extra bundle resource. Both languages are bundled; the dialog
picks the one matching the UI language.

## Keeping it in step

When an upstream is ported or its licence changes:

1. Update [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) and its
   `.zh-CN.md` translation, and add the licence text under `licenses/`.
2. Update the porting record in
   [`docs/UPSTREAM_PROJECTS.md`](../../docs/UPSTREAM_PROJECTS.md).
3. Add or edit the matching row in `UPSTREAMS` so the dialog lists it.

## Strings

All copy lives under `about.thirdParty` and `about.licenses*` in
[`src/i18n/locales/en.json`](../../src/i18n/locales/en.json) and
[`src/i18n/locales/zh.json`](../../src/i18n/locales/zh.json). Upstream names,
licence identifiers and module paths are not translated.

## Limits

- The full notices are rendered as plain text, not as formatted Markdown; the
  structured source list is the part meant for reading.
- The dialog is display-only: it does not read files from disk, so it shows the
  notices that were current when the build was made.

<div align="center">

<img src="./assets/logo.svg" width="120" height="120" alt="WingHarness logo" />

# WingHarness

English | [简体中文](./README.zh-CN.md)

[![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8DB?logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-GPLv3-blue)](./LICENSE)

A Tauri v2 desktop template: the shell and the native plumbing are already wired,
so the first feature you write is a feature and not a window frame.

</div>

## What's in it

More than `create-tauri-app` hands you, but nothing that belongs to a particular
product:

- **Frameless window with a custom title bar** — drag, minimize, maximize, close and a window context menu, on a transparent rounded window
- **In-app router** — pathname-based, pages load lazily, and window routes bring their own frame. Navigating swaps the page and keeps the sidebar mounted instead of reloading the document
- **Light / dark / system theme, plus font presets** — a preset brings its own fonts, downloaded on first use and cached locally
- **System tray** — icon, themed right-click menu, and a popup window
- **Global shortcuts** — registered with the OS, changeable at runtime and kept across restarts
- **Internationalization** — i18next with English and Chinese, one key set, no untranslated keys
- **Local terminal** — a real pseudo-console (`portable-pty`) rendered in the webview
- **Notes** — a Markdown store under the data directory, edited with the bundled codelet editor
- **Project file browser** — a directory tree served one level at a time and confined to a single root
- **File preview** — Word, Excel, PowerPoint, PDF, images, archives, e-books, PSD, XMind, audio and video parsed in the webview, text editing with encoding selection, and a standalone window that the Space key opens from Explorer, the desktop or Everything
- **Data directory settings** — every piece of persisted state lives under one configurable directory
- **About and settings windows** — each one a worked example of a second window with its own route
- **Auto-update** — signed releases published by GitHub Actions, installed through Tauri's updater
- **TypeScript strict, ESLint and Prettier** — configured rather than implied

## Tech Stack

- **Desktop Framework**: [Tauri v2](https://tauri.app/) (Rust)
- **Frontend Framework**: [React 19](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- **Build Tool**: [Vite](https://vite.dev/)
- **UI Components**: [shadcn/ui](https://ui.shadcn.com/)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/)
- **Editor Engine**: [codelet](https://www.npmjs.com/package/codelet) — the editor is a dependency, not a framework
- **Code Formatting**: [Prettier](https://prettier.io/) + [ESLint](https://eslint.org/)

## Getting Started

### Prerequisites

- Node.js >= 18
- pnpm >= 9
- Rust >= 1.70

### Install and run

```bash
pnpm install
pnpm tauri dev      # Vite dev server on :11421 + the app
```

### Build for production

```bash
pnpm tauri build          # NSIS bundle
pnpm tauri:build:ps       # signed NSIS + updater artifacts (scripts/build.ps1)
```

### Check everything

```bash
pnpm check          # prettier --check, eslint, tsc, vite build
```

## Project Structure

```
.
├── src/                      # Frontend (React + TypeScript)
│   ├── main.tsx              # Entry: pageMap + standalonePaths
│   ├── pages/                # Main-window pages: start, local-terminal, notes, file-preview, project; preview-window is its own window
│   ├── windows/              # Own-window routes: about, settings, tray-menu
│   ├── components/           # Shell, title bar, sidebar, file preview, shadcn/ui primitives
│   ├── lib/                  # router, app-routes, editor, preview viewers, fonts, terminal, theme
│   ├── commands/             # Typed wrappers over the Tauri commands (one module per domain)
│   ├── hooks/                # Shared React hooks
│   └── i18n/                 # i18next setup + locales/{en,zh}.json
├── src-tauri/                # Backend (Rust)
│   ├── src/                  # commands/, config/, fonts/, theme/, plugins/ (tray)
│   ├── file-preview/         # Workspace crate: the legacy preview page's byte reader
│   ├── space-preview-core/   # Workspace crate: preview I/O, text encodings, Windows space agent
│   └── tauri.conf.json       # Windows, bundle and updater configuration
├── docs/                     # Cross-cutting guides; feature guides in features/
└── scripts/                  # Release versioning, theme presets, build.ps1
```

## Pages and windows

| Route | File | Kind |
|-------|------|------|
| `/` | `pages/start/index.tsx` | main window |
| `/local-terminal` | `pages/local-terminal/index.tsx` | main window |
| `/notes` | `pages/notes/index.tsx` | main window |
| `/file-preview` | `pages/file-preview/index.tsx` | main window |
| `/preview-window` | `pages/preview-window/index.tsx` | own window |
| `/project` | `pages/project/index.tsx` | main window |
| `/about` | `windows/about/index.tsx` | own window |
| `/settings` | `windows/settings/index.tsx` | own window |
| `/tray-menu` | `windows/tray-menu/index.tsx` | own window |

Main-window pages are wrapped in the shared `AppShell`; the window routes are
listed in `standalonePaths` and render their own frame. `/preview-window` is
declared hidden and shown by the preview's space agent.

## Adding Things

### A page

1. Create `src/pages/<name>/index.tsx` and render it inside `<AppShell>`
2. Add a `pageMap` entry in `src/main.tsx`
3. Add an `appRoutes` row in `src/lib/app-routes.ts` (id, path, icon, and the
   labels — they are literal strings in that file, not i18n keys)

### A Tauri command

A command has to be named in four places or it will fail at runtime — see
[src-tauri/CLAUDE.md](./src-tauri/CLAUDE.md). `build.rs` fails the build when the
first two disagree.

### A shadcn/ui component

```bash
pnpm dlx shadcn@latest add button
```

## Documentation

Guides are written twice, English and Chinese (`X.md` / `X.zh-CN.md`). The
cross-cutting ones sit at the root of `docs/`; everything specific to one
feature lives under `docs/features/`.

| Guide | What it covers |
|-------|----------------|
| [docs/AUTO_UPDATE.md](./docs/AUTO_UPDATE.md) | Update endpoints, signing keys, GitHub Actions release flow |
| [docs/GLOBAL_SHORTCUT.md](./docs/GLOBAL_SHORTCUT.md) | Registering shortcuts with the OS |
| [docs/I18N.md](./docs/I18N.md) | i18next setup and how to add a language |
| [docs/UPSTREAM_PROJECTS.md](./docs/UPSTREAM_PROJECTS.md) | Every upstream project, its licence, and the porting record |

### Feature guides

A guide is added together with its feature; the ones below are also the
specification the port follows, so some describe pages that are not in this
repository yet.

| Guide | What it covers |
|-------|----------------|
| [AI_CONFIG.md](./docs/features/AI_CONFIG.md) | AI config sync: one git store, materialised into each agent's layout |
| [API_CLIENT.md](./docs/features/API_CLIENT.md) | Postman-like REST client driven by an OpenAPI or Swagger document |
| [CC_SWITCH.md](./docs/features/CC_SWITCH.md) | Provider management for the AI coding CLIs |
| [CLAUDE_CODE.md](./docs/features/CLAUDE_CODE.md) | The Claude chat, history and workflow pages |
| [DATABASE.md](./docs/features/DATABASE.md) | Data sources, tabbed data-source windows with persisted query files and tabs, SQL console, execution plans, table data and object management |
| [FILE_PREVIEW.md](./docs/features/FILE_PREVIEW.md) | The preview engine, the standalone Space window, text editing, supported formats, how to add one |
| [FRP.md](./docs/features/FRP.md) | FRP console: generated `frpc` configs, child processes, logs |
| [GIT.md](./docs/features/GIT.md) | Local Git client, one window per repository |
| [MCP_HUB.md](./docs/features/MCP_HUB.md) | One local endpoint in front of the local MCP servers |
| [MD_EDITOR.md](./docs/features/MD_EDITOR.md) | Multi-tab Markdown editor over files left in place |
| [MOIN.md](./docs/features/MOIN.md) | HTTP/HTTPS downloads, segmented resume, queues, categories and aria2 |
| [MOIN_EXTENSION.md](./docs/features/MOIN_EXTENSION.md) | Browser download capture, pairing, permissions and privacy |
| [NOTES.md](./docs/features/NOTES.md) | Markdown notes kept in the data directory |
| [PLUGINS.md](./docs/features/PLUGINS.md) | The plugin format, its manifest, and the generated settings UI |
| [PORTS.md](./docs/features/PORTS.md) | TCP listening ports, the pinned set, and ending the process behind a port |
| [PROJECT.md](./docs/features/PROJECT.md) | The project file explorer and editor |
| [RUNTIME.md](./docs/features/RUNTIME.md) | Downloading and installing the mihomo and frpc runtimes |
| [SCOOP.md](./docs/features/SCOOP.md) | Installing Scoop, its two folders and links, environment variables, the proxy, and its apps and buckets |
| [SERVERS.md](./docs/features/SERVERS.md) | SSH / SFTP server manager |
| [SVN.md](./docs/features/SVN.md) | Native Subversion workspace |
| [SYSTOOLS.md](./docs/features/SYSTOOLS.md) | Windows maintenance console |
| [TERMINAL.md](./docs/features/TERMINAL.md) | The pseudo-console page |
| [THIRD_PARTY_LICENSES.md](./docs/features/THIRD_PARTY_LICENSES.md) | The About window's third-party licence dialog |

## Release & Auto-Update

`pnpm release:version` is the release entrypoint. It checks that the working tree is
clean, that the branch is `main`, and that `package.json`,
`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` agree on the version — then
bumps all three, commits, and tags `vX.Y.Z`. Pushing the tag runs the GitHub
Actions workflow, which builds the installer into a **draft** release whose body
is generated from the commits since the previous tag. Review the draft, then
publish it — the updater only sees published releases.

```bash
pnpm release:version
```

Signing keys are `wingharness.key` / `wingharness.key.pub`. `scripts/build.ps1`
reads them from `.key/` at the repo root by default and takes `-PrivateKeyPath` /
`-PublicKeyPath` to point elsewhere; `.remake` shows the manual `$HOME/.tauri`
route. CI supplies them as the `TAURI_SIGNING_*` repository secrets.

## License

GNU General Public License, version 3 only (GPL-3.0-only). See
[LICENSE](./LICENSE).

Copyright (C) 2026 Anfioo.

Third-party components keep their own licenses — see
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md), with the license texts in
[licenses/](./licenses/). The origin of every ported subsystem, and which
upstream projects must not be ported, is recorded in
[docs/UPSTREAM_PROJECTS.md](./docs/UPSTREAM_PROJECTS.md).

## 🤝 Contributing

Contributions are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) first — it
covers the development setup, the commit format, and the rules for porting code
from an upstream project.

<a href="https://github.com/Anfioo/WingHarness/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Anfioo/WingHarness" alt="WingHarness contributors" />
</a>

## ⭐ Star History

<a href="https://www.star-history.com/?repos=Anfioo%2FWingHarness&type=date&releases=&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Anfioo/WingHarness&type=date&theme=dark&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Anfioo/WingHarness&type=date&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Anfioo/WingHarness&type=date&legend=bottom-right" />
 </picture>
</a>
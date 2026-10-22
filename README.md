<div align="center">

# WingHarness

English | [简体中文](./README.zh-CN.md)

[![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8DB?logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green)](./LICENSE)

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
- **Read-only file preview** — Word, Excel, PowerPoint, PDF, images, archives, e-books, PSD, XMind, audio and video, all parsed in the webview
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
pnpm tauri dev      # Vite dev server on :11420 + the app
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
│   ├── pages/                # Main-window pages: start, local-terminal, notes, file-preview, project
│   ├── windows/              # Own-window routes: about, settings, tray-menu
│   ├── components/           # Shell, title bar, sidebar, file preview, shadcn/ui primitives
│   ├── lib/                  # router, app-routes, editor, preview viewers, fonts, terminal, theme
│   ├── commands/             # Typed wrappers over the Tauri commands (one module per domain)
│   ├── hooks/                # Shared React hooks
│   └── i18n/                 # i18next setup + locales/{en,zh}.json
├── src-tauri/                # Backend (Rust)
│   ├── src/                  # commands/, config/, fonts/, theme/, plugins/ (tray)
│   ├── file-preview/         # Workspace crate: the preview page's byte reader
│   └── tauri.conf.json       # Windows, bundle and updater configuration
├── docs/                     # Guides for the retained features
└── scripts/                  # Release versioning, theme presets, build.ps1
```

## Pages and windows

| Route | File | Kind |
|-------|------|------|
| `/` | `pages/start/index.tsx` | main window |
| `/local-terminal` | `pages/local-terminal/index.tsx` | main window |
| `/notes` | `pages/notes/index.tsx` | main window |
| `/file-preview` | `pages/file-preview/index.tsx` | main window |
| `/project` | `pages/project/index.tsx` | main window |
| `/about` | `windows/about/index.tsx` | own window |
| `/settings` | `windows/settings/index.tsx` | own window |
| `/tray-menu` | `windows/tray-menu/index.tsx` | own window |

Main-window pages are wrapped in the shared `AppShell`; the three window routes
are listed in `standalonePaths` and render their own frame.

## Adding Things

### A page

1. Create `src/pages/<name>/index.tsx` and render it inside `<AppShell>`
2. Add a `pageMap` entry in `src/main.tsx`
3. Add an `appRoutes` row in `src/lib/app-routes.ts` (id, path, icon)
4. Add `routes.<id>.{title,scope,description}` to both locale files

### A Tauri command

A command has to be named in four places or it will fail at runtime — see
[src-tauri/CLAUDE.md](./src-tauri/CLAUDE.md). `build.rs` fails the build when the
first two disagree.

### A shadcn/ui component

```bash
pnpm dlx shadcn@latest add button
```

## Documentation

| Guide | What it covers |
|-------|----------------|
| [docs/AUTO_UPDATE.md](./docs/AUTO_UPDATE.md) | Update endpoints, signing keys, GitHub Actions release flow |
| [docs/FILE_PREVIEW.md](./docs/FILE_PREVIEW.md) | The viewer subsystem, supported formats, how to add one |
| [docs/GLOBAL_SHORTCUT.md](./docs/GLOBAL_SHORTCUT.md) | Registering shortcuts with the OS |
| [docs/I18N.md](./docs/I18N.md) | i18next setup and how to add a language |

## Release & Auto-Update

`pnpm release:version` is the release entrypoint. It checks that the working tree is
clean, that the branch is `main`, and that `package.json`,
`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` agree on the version — then
bumps all three, commits, and tags `vX.Y.Z`. Pushing the tag runs the GitHub
Actions workflow, which builds the installer and publishes the release the updater
reads.

```bash
pnpm release:version
```

Signing keys are `wingharness.key` / `wingharness.key.pub`. `scripts/build.ps1`
reads them from `.key/` at the repo root by default and takes `-PrivateKeyPath` /
`-PublicKeyPath` to point elsewhere; `.remake` shows the manual `$HOME/.tauri`
route. CI supplies them as the `TAURI_SIGNING_*` repository secrets.

## License

MIT
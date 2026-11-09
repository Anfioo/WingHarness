[Root](../CLAUDE.md) > **src**

# Frontend Module (src)

## Responsibilities

UI rendering, routing, interaction, styling, internationalization, and the two
webview-side subsystems that carry most of the frontend's weight: the codelet
editor and the file-preview viewers. Built with React 19 + TypeScript + Tailwind
CSS v4 + shadcn/ui.

## Entry Points

- **Entry**: `main.tsx` — `pageMap` maps a pathname to a lazily imported page;
  `standalonePaths` names the routes that are their own window and bring their
  own frame
- **Routing**: `lib/router.tsx` (`RouterProvider` + `useRouter()`)
- **Route table**: `lib/app-routes.ts` (`AppRouteId`, `appRoutes`)
- **Pages** (`pages/`): `project` (the picker at `/` and one window per project),
  `git-repo`, `svn-workspace`, `api-client`, `systools`, `servers`, `database`,
  `frp`, `md-editor`, `local-terminal`, `notes`, `file-preview`, `quick-preview` (the quick-look window), `ai-config`,
  `claude-chat`, the Claude history and workflow pages, `cc-switch`,
  `mcp-hub`, `clash`, `plugins`, `private-registry`
- **Windows** (`windows/`): `about`, `settings`, `tray-menu`, `update`
- **Chrome** (`components/`): `app-shell.tsx` (sidebar + header, shared by every
  main-window page), `app-sidebar.tsx`, `window-frame.tsx`, `title-bar.tsx`,
  `main-title-bar.tsx`
- **Build Tool**: Vite 7, dev port 11421

## Routing

`pageMap` holds every route: sidebar pages, window pages and the small utility
windows. Window routes are also listed in `standalonePaths` and render their own
frame instead of the shared `AppShell`.

- In-app links go through `router.navigate()`, never a bare `<a href>` — a plain
  anchor reloads the whole document, while the router keeps the shell (sidebar,
  shortcut registration, updater) mounted and swaps only the page.
- A page still renders `<AppShell>` around its own content. That inner one is a
  no-op by design: otherwise it would draw a second frame and remount the sidebar
  on every navigation, which is the reload the router exists to avoid.
- `main` keys its scroller on the URL, so a new page starts at the top instead of
  at the previous page's scroll offset.

### Adding a page

1. `src/pages/<name>/index.tsx` — the default export, wrapped in `<AppShell>`
2. Add the lazy entry to `pageMap` in `src/main.tsx`
3. Add a row to `appRoutes` in `src/lib/app-routes.ts` (id, path, icon, and the
   `title` / `navLabel` / `description` / `scope` / `items` strings — these are
   literal strings in that file, not i18n keys)

### Adding a window

As above, plus:

1. List the route in `standalonePaths` (`src/main.tsx`)
2. Add a window record to `app.windows` in `src-tauri/tauri.conf.json`
3. Add its label to `windows` in `src-tauri/capabilities/default.json`, or every
   command call from it is refused by the ACL

## Commands

`commands/` holds typed wrappers over the Tauri commands. There is one module per
domain under `commands/services/`, and `commands/index.ts` re-exports their
functions and types — it is the only thing components import:

| Domain | What it covers |
|--------|----------------|
| `config` | the config file and the data directory — no project |
| `database` | data sources, connections, transactions, multi-statement queries, query files and persisted window tabs, execution plans, table paging and row editing, DDL, completion and history. Ids prefixed `whp-` route to the project-scoped engine, the list / query-file / settings commands take an optional `scope`, and every project-reaching command sends the caller's active `root` |
| `devtools` | opening the webview inspector |
| `file-preview` | metadata and raw bytes for the preview page, read from the `root` the caller passes |
| `fonts` | enumerating installed font families |
| `local-shell` | the terminal's pseudo-console, and its font list |
| `notes` | the Markdown store |
| `project-fs` | the confined project file tree and its read/write/delete, rooted at the `root` the caller passes |
| `projects` | the recent-project list, the active project, and remember / forget / set-active |
| `theme` | the CSS for a theme preset's web fonts |
| `tray` | quitting, and updating the tray menu labels |
| `updater` | update download and install |

```typescript
import { getConfig, projectTree } from "@/commands";
```

**The active project is per webview.** `commands/project-context.ts` holds it in
a module variable — each window has its own JavaScript context, so two project
windows never share one. A project window sets it when it mounts, and a page
with a `ProjectPicker` sets it when the user chooses; the wrappers for
`project-fs`, `file-preview`, `shaic` and `database` read it. Never call a
project command from a page that has no root in play.

## Layout

- `lib/` — `router.tsx`, `app-routes.ts`, `shortcut.ts`, `window.ts`,
  `window-label.ts`, the per-feature window helpers (`project-windows.ts`,
  `git-windows.ts`, `svn-windows.ts`, `database-windows.ts`, `quick-preview.ts`), `updater.ts`,
  `utils.ts`, plus the `editor/`, `preview/`, `fonts/`, `terminal/` and `theme/`
  subsystems
- `features/` — one directory per feature that is larger than one page's own
  components: `api-client/`, `database/project/` (the project page's database
  panel, its store, tabs and results dock), `git/` (the project page's Git
  views), `md-editor/`, `svn-workspace/`
- `hooks/` — `use-app-translation` (use this one, not `useTranslation`
  directly: it also listens for the cross-window language change event),
  `use-config-draft`, `use-file-preview-config`, `use-shortcut-config`, `use-maximized`, `use-mobile`,
  `use-updater`, and the "*show home*" listeners (`use-project-home`,
  `use-git-home`, `use-svn-home`)
- `components/ui/` — shadcn/ui primitives; leave these as generated
- `i18n/index.ts` — i18next configuration

## Path Alias

```typescript
// Configured in tsconfig.json; "@/*" maps to "./src/*"
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
```

## Internationalization

```typescript
import { useAppTranslation } from "@/hooks/use-app-translation";

function MyComponent() {
  const { t } = useAppTranslation();

  return <h1>{t("app.title")}</h1>;
}
```

- **Languages**: English (en), Chinese (zh)
- **Files**: `i18n/locales/{en,zh}.json` — the two must stay key-for-key
  identical, and no key may exist without a caller
- **Route strings** are the `title`, `navLabel` and `description` fields of the
  `appRoutes` row, and the sidebar and the header both read them from there, so
  the two can never disagree
- See [docs/I18N.md](../docs/I18N.md)

## Toast Notifications

sonner, via shadcn/ui. Import the function, not a component:

```typescript
import { toast } from "sonner";

toast.success(t("settings.shortcut.setSuccess", { shortcut: "Ctrl+Shift+A" }));
toast.error(message);
```

`<Toaster />` (`@/components/ui/sonner`) is already mounted by the shell. Toasts
follow the theme and auto-dismiss after 4s.

## Styling

- Tailwind CSS v4 with CSS variables for theming; `components.json` configures
  shadcn/ui
- Add a primitive with `pnpm dlx shadcn@latest add <component>` rather than
  hand-writing one

## Tauri API Usage

```typescript
import { invoke } from "@tauri-apps/api/core";

const result = await invoke("project_tree", { path: "/", depth: 1 });
```

Prefer the typed wrapper in `@/commands` over a raw `invoke` — it carries the
argument and return types, and it is the only place that spells a command name.

## Code Quality

```bash
pnpm format        # Format code
pnpm format:check  # Check formatting
pnpm lint          # ESLint
pnpm check         # All of the above plus tsc and vite build
```

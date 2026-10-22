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
- **Pages** (`pages/`): `start`, `local-terminal`, `notes`, `file-preview`,
  `project`
- **Windows** (`windows/`): `about`, `settings`, `tray-menu`, `update`
- **Chrome** (`components/`): `app-shell.tsx` (sidebar + header, shared by every
  main-window page), `app-sidebar.tsx`, `window-frame.tsx`, `title-bar.tsx`,
  `main-title-bar.tsx`
- **Build Tool**: Vite 7, dev port 11420

## Routing

`pageMap` holds nine routes: five pages and four windows. The pages are wrapped
in the shared `AppShell`; the four window routes are listed in `standalonePaths`
and render their own frame instead.

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
3. Add a row to `appRoutes` in `src/lib/app-routes.ts` (id, path, icon)
4. Add `routes.<id>.{title,scope,description}` to both locale files — the sidebar,
   the header and the header's help tip all read from there

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
| `config` | the config file, the project root, the data directory |
| `devtools` | opening the webview inspector |
| `file-preview` | metadata and raw bytes for the preview page |
| `fonts` | enumerating installed font families |
| `local-shell` | the terminal's pseudo-console, and its font list |
| `notes` | the Markdown store |
| `project-fs` | the confined project file tree and its read/write/delete |
| `theme` | the CSS for a theme preset's web fonts |
| `tray` | quitting, and updating the tray menu labels |
| `updater` | update download and install |

```typescript
import { getConfig, projectTree } from "@/commands";
```

## Layout

- `lib/` — `router.tsx`, `app-routes.ts`, `shortcut.ts`, `window.ts`,
  `updater.ts`, `utils.ts`, plus the `editor/`, `preview/`, `fonts/`,
  `terminal/` and `theme/` subsystems
- `hooks/` — `use-app-translation` (use this one, not `useTranslation`
  directly: it also listens for the cross-window language change event),
  `use-config-draft`, `use-maximized`, `use-mobile`, `use-updater`
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
- **Route strings** live under `routes.<id>` and are looked up by
  `t(\`routes.${id}.title\`)`, so the sidebar and the header can never disagree
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

# Tray Menu

The **托盘菜单** (Tray menu) tab decides what the system tray's second-level
menu offers: the apps list behind the **应用** (Apps) row of the tray popup.
Scoop writes one Start Menu shortcut per installed app that has one, and that
shortcut already carries the target, its arguments, the working directory and
the icon — so the tab lists those shortcuts, and clicking one in the tray opens
it through the shell.

The tab belongs to the Scoop page (`/scoop?tab=tray`) and exists once Scoop is
installed, because the list it curates is Scoop's Start Menu folder. The tray
popup itself is a separate frameless window (`tray-menu`), described in
[src-tauri/CLAUDE.md](../../src-tauri/CLAUDE.md).

Windows only. The tray popup, its flyouts and this tab are the Windows form of
the tray; macOS and Linux keep the native menu, which carries no app list.

## The tray popup

The popup's rows and their height arithmetic live in
`src-tauri/src/plugins/tray_popup.rs`; its contents live in
`src/windows/tray-menu/index.tsx`. The two have to move together, because the
window is sized from constants rather than measured:

| Row | Height |
| --- | --- |
| Each menu item | `32px` (`h-8`) |
| Padding around them | `4px` top + `4px` bottom (`p-1`) |
| The divider before Quit | `9px` (`my-1 h-px`) |
| Item count constant | `MENU_ITEM_COUNT` in `tray_popup.rs` |

Show window / Settings / Space preview / Open file / **Apps** / Clash / FRP /
**Background monitoring** / Quit is nine items, so the collapsed popup is 305px
tall. Adding a row means changing the constant, the `h-[305px]` class, and
nothing else. The background-monitoring row toggles the task manager's
`backgroundMonitoring` setting; see
[TASK_MANAGER.md](./TASK_MANAGER.md#tray-row).

A flyout (Clash, FRP, or the apps' second-level menu) replaces that geometry with
340 × 460 and the window grows sideways, to the left of the menu column unless
the icon sits near the left edge of the screen. `tray_menu_set_expanded` does the
resize and reports which side it took.

## The apps list

`commands/tray_apps.rs` reads `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Scoop Apps\*.lnk`
and, one level down, the subfolder Scoop makes for an app with several
shortcuts (`7-Zip\7-Zip File Manager.lnk`):

- the **id** is the file stem, lowercased for comparisons and stored as it is
- the **display name** is the stem with `_` as spaces, which is how Scoop names
  the shortcuts of apps whose display name has spaces in it
- the **path** is the `.lnk` itself; nothing parses it

Launching is `open_path`, the shell-open command every window already has:
`cmd /C start "" "<path>"`. The shortcut brings its own working directory and
arguments, so the app starts exactly as it would from the Start Menu. There is no
separate launch bridge, and no `lnk` dependency.

Apps installed without a Start Menu shortcut (mostly CLI tools, which get shims
instead) are not listed: there is nothing to start that a tray menu could show.
The tab says so, and names the folder it read, so an empty list is not a
mystery.

Icons come from `sp_file_icon` — the shell reads the icon of the `.lnk` — through
`systemFileIcon` in `src/lib/space-preview/bridge.ts`. A shortcut with no icon
falls back to a coloured letter derived from the id, which keeps every row
aligned.

## Curation and order

Three id lists, all in `<data dir>/tray.json`:

```json
{ "pinned": ["Everything"], "hidden": ["7zip"], "order": ["Everything", "Notepad++", "7zip"] }
```

- **pinned** apps are drawn above a divider; **hidden** apps are dropped from
  the menu but stay in the settings list
- **order** is the menu order the user set by dragging; inside each section the
  apps follow it. Ids missing from `order` sort after the ranked ones,
  alphabetically, so a freshly installed app lands at the end instead of
  disturbing the arrangement
- dragging a row reorders it; the list is a dnd-kit sortable, so the rows part
  to show where the dragged one will land. Dropping across the divider pins or
  unpins the dragged app, which is what that divider means. The pin button is a
  shortcut that puts the app at the front. Dragging is off while the search box
  has text, because a filtered sequence is not a saved order
- `tray_apps_save` replaces all three lists and normalizes them (trimmed,
  deduplicated, order preserved); it keeps ids the folder no longer holds, so
  an app that is uninstalled and installed again comes back where the user put
  it

The tray reads the file whenever its popup opens, so a change needs no signal to
the tray: there is nothing to restart and nothing to rebuild. The settings tab
saves as each toggle or drop happens and puts the previous lists back if the
write fails.

## Files

| Path | Responsibility |
| --- | --- |
| `src-tauri/src/commands/tray_apps.rs` | The shortcut scan, the ordering, `tray.json`, and the two commands |
| `src-tauri/src/plugins/tray_popup.rs` | Popup geometry, placement, blur-to-close |
| `src/windows/tray-menu/index.tsx` | The menu rows and the flyout plumbing |
| `src/windows/tray-menu/apps-panel.tsx` | The apps flyout |
| `src/pages/scoop/index.tsx` | The host page: the tab, its `?tab=` deep link and the tab-select event |
| `src/components/scoop/tray-panel.tsx` | The Scoop tab: list, drag order, pin, hide, preview |
| `src/hooks/use-tray-apps-page.ts` | Tab state, the optimistic save, the filter |
| `src/components/tray-apps/` | The shared app icon, app row and menu preview |
| `src/commands/services/tray/` | Typed wrappers over the tray commands and their DTOs |
| `src/lib/scoop-tabs.ts` | The tab names and the event that selects one |

## Commands

| Command | Purpose |
| --- | --- |
| `tray_apps_list` | The apps in menu order, all three lists, and the folder they came from |
| `tray_apps_save` | Replaces the pinned, hidden and order lists |

The tab may be reached from the tray itself: the flyout's **编辑托盘菜单…** row
hides the popup, shows the main window and emits `app:navigate` with
`/scoop?tab=tray`, addressed to `main`, which the router turns into a normal
navigation. It then emits `scoop-select-tab`, because navigating to the URL that
is already current is deliberately a no-op — without the event, coming back to
the tab after clicking another one would leave the clicked tab showing. The main
window is hidden rather than destroyed on close, so its router is still there to
receive both.

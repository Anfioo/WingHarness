# Browser download capture

**WingHarness — download capture** is the companion browser extension for the
Downloads page. It sends HTTP/HTTPS links, the browser-selected filename and the
request context to WingHarness over `127.0.0.1`. The source lives in
`extension/`; it is plain JavaScript, has no runtime dependencies and is not
included in the desktop installer.

## Capture paths and behaviour

The extension can hand off a download in three ways:

1. **Link click.** A content script intercepts a downloadable link before the
   browser requests it. This avoids the browser save dialog on the fast path.
2. **Response interception, Firefox only.** The Firefox MV3 build can cancel a
   server-driven attachment before its save dialog and forward it.
3. **Browser download fallback.** For missed cases, the extension pauses a newly
   created browser download and forwards its URL. Chromium may already have
   shown the save dialog at this point.

Every path can include the target URL's cookies, the referer and user-agent.
Right-clicking a link, image or video and choosing **Download with
WingHarness** is always available while capture is enabled. Automatic capture
is off by default. `blob:`, `data:`, streaming-media and non-HTTP URLs stay in
the browser because WingHarness cannot fetch them as plain HTTP resources.

WingHarness must already be running. There is no custom URL scheme or deep link
to launch it. When the app is unreachable, the prompt can wait while you start
it manually; declining the prompt leaves the download to the browser.

## Pairing

1. Start WingHarness and open **Downloads → Settings → Browser integration**.
2. Enable browser integration, note the port (default `47653`) and copy the
   access token. The app generates and stores this token; the extension never
   invents one.
3. Open the extension options by clicking its toolbar icon. Paste the token and
   enter the same port.
4. Click **Test connection**. A successful check reports the WingHarness
   version.

Changing the app's switch or port takes effect after an app restart. Regenerating
the token takes effect immediately and invalidates the old one; copy the new
value into the extension options as well.

## Load in Chrome, Edge or Brave

1. Open `chrome://extensions`, `edge://extensions` or `brave://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the repository's `extension/` folder.
   Its `manifest.json` is the Chromium MV3 manifest with a service worker.

No compile step is required for this path.

## Load in Firefox

Firefox uses background scripts instead of the Chromium service worker. Build
the browser-specific folders from `extension/`:

```bash
node build.mjs
```

Then open `about:debugging#/runtime/this-firefox`, choose **Load Temporary
Add-on…** and select `dist/firefox/manifest.json`. Grant host access if Firefox
asks for it. Temporary add-ons are removed when Firefox restarts and must be
loaded again.

The same command also creates `dist/chrome` and versioned Chrome/Firefox zip
files. It only packages the extension and does not participate in the app's
`pnpm build`.

## Permissions

| Permission                          | Why it is needed                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `downloads`                         | Detect and pause browser downloads for fallback capture.                         |
| `contextMenus`                      | Add **Download with WingHarness** to supported page elements.                    |
| `cookies` and host access           | Read cookies only for the submitted download URL and contact `127.0.0.1`.        |
| `notifications`                     | Show success and error feedback.                                                 |
| `tabs`                              | Read the source page URL and display the app-start prompt.                       |
| `storage`                           | Save the port, token and capture preferences in browser-local extension storage. |
| `webRequest` / `webRequestBlocking` | Firefox only: intercept a server-driven attachment before its save dialog.       |

The extension runs only bundled code and does not download or execute remote
code.

## Privacy and local data

The extension has no analytics, tracking, remote service or developer endpoint.
The submitted URL, filename, cookies, referer and user-agent go only to
`http://127.0.0.1:<port>` on the user's machine. They are not sent to a third
party by the extension.

The token and capture preferences stay in the browser's extension storage.
After submission, WingHarness can persist the request headers in
`<data dir>/moin/downloads.db` and stores its own RPC token in
`<data dir>/moin/settings.json`. Protect both locations as sensitive data; see
[MOIN.md](./MOIN.md#data-layout-and-sensitive-data).

## RPC contract

- `GET /ping` requires no token and returns
  `{ "app": "wingharness", "version": "…" }`.
- `POST /add` requires `Authorization: Bearer <token>` and a JSON body such as
  `{ "url": "https://…", "headers": { "Cookie": "…", "Referer": "…", "User-Agent": "…" }, "filename": "…" }`.
  Success returns the created task. Failure returns a non-2xx response with
  `{ "error": "…" }`.

The connection test deliberately posts `{}` to `/add`: `401` means the token is
wrong, while `400` for the missing URL proves that the app is reachable and the
token is accepted.

## Troubleshooting

| Symptom                                   | Action                                                                                                                                                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WingHarness is unreachable                | Start the app, enable browser integration and make the ports match. Restart after changing the app's switch or port.                                                                                                   |
| The test returns 401                      | Copy the current token from the app and paste it into the extension. No app restart is needed for a token change.                                                                                                      |
| The port is occupied                      | Choose another port in the app, restart it, then use the same port in the extension. A bind failure does not crash WingHarness.                                                                                        |
| Chromium still opens a save dialog        | Enable auto-capture for link clicks. For a server-driven attachment, disable **Ask where to save each file before downloading** or accept the fallback behaviour.                                                      |
| Right-click does nothing                  | Check the extension's capture switch and use a direct HTTP/HTTPS link. Browser-internal, `blob:` and `data:` URLs are unsupported.                                                                                     |
| Nothing appears in Downloads              | Check the app's task list, then inspect the extension background console. Chromium exposes **Inspect views: service worker**; Firefox exposes **Inspect** under `about:debugging`. Extension logs use `[wingharness]`. |
| Firefox loses the extension after restart | This is expected for a temporary add-on. Load `dist/firefox/manifest.json` again.                                                                                                                                      |

## Source layout

```
extension/
  manifest.json            Chrome/Edge/Brave MV3, service worker
  manifest.firefox.json    Firefox MV3, background scripts
  build.mjs                Build dist/chrome and dist/firefox, then zip them
  icons/                   SVG source and 32/48/128 PNG icons
  src/
    shared.js              Options, RPC client and cookie header
    content.js             Click interception and in-page app-start prompt
    background.js          Menus, capture paths, notifications and retry prompt
    prompt.html/.js        Popup prompt for restricted pages
    options.html/.js/.css  Pairing and capture preferences
```

## Credits

Adapted from [moin](https://github.com/exxvius/moin) 0.4.0 at commit `79e7587`
(MIT). The `/ping` and `/add` contract remains compatible. WingHarness changes
the branding, keeps browser integration on port `47653`, and replaces automatic
`moin://` launching with an explicit start-app prompt.

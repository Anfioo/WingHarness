// Adapted from moin (MIT), https://github.com/exxvius/moin — see PRIVACY.md.
//
// The background worker: capture downloads and hand them to WingHarness.
//
// Two capture paths — the browser's own downloads (auto-intercept) and a
// right-click "Download with WingHarness" — funnel through `capture()`. When
// WingHarness isn't running the user is asked first (never captured silently);
// declining lets the browser download normally. The extension can't start the
// app itself, so the prompt tells the user to open WingHarness and then retries.

// Chrome service worker: pull in the shared helpers. Firefox loads shared.js
// itself via the manifest, where `importScripts` doesn't exist — hence the guard.
if (typeof importScripts === "function") {
  importScripts("shared.js");
}

// How long to keep polling WingHarness's RPC after the user says they started it.
const RETRY_TIMEOUT_MS = 20000;
// After a decline while WingHarness is down, stop prompting on auto-captured
// downloads for this long, so a user who just wants the browser isn't nagged.
const SUPPRESS_AFTER_DECLINE_MS = 60000;
// Let the browser finish redirect resolution before we hand the URL to the app.
const FINAL_URL_SETTLE_MS = 350;
const FINAL_URL_TIMEOUT_MS = 8000;

// URLs we deliberately handed back to the browser (the manual-decline fallback),
// so `onCreated` / the response interceptor don't capture them again and loop.
const bypass = new Set();
// Explicit context-menu captures first let the browser resolve redirects, then
// hand the resulting download to WingHarness from `downloads.onCreated`.
const pendingManualCaptures = new Map();
const activeManualCaptureTabs = new Map();
// Timestamp until which auto-capture stays out of the way after a decline.
let suppressAutoUntil = 0;

// A cached copy of the config so the synchronous webRequest hook can gate on it.
let cachedConfig = { ...DEFAULTS };
loadConfig().then((c) => (cachedConfig = c));
B.storage.onChanged.addListener(() => loadConfig().then((c) => (cachedConfig = c)));

// ---- Context menu (manual capture) --------------------------------------

function setupMenus() {
  B.contextMenus.removeAll(() => {
    B.contextMenus.create({
      id: "wingharness-download",
      title: "Download with WingHarness",
      contexts: ["link", "image", "video", "audio", "selection"],
    });
  });
}

B.runtime.onInstalled.addListener(setupMenus);
B.runtime.onStartup.addListener(setupMenus);

// Clicking the toolbar icon opens the options page (there's no default popup).
B.action.onClicked.addListener(() => {
  B.runtime.openOptionsPage();
});

function queueManualCapture(request) {
  const requests = pendingManualCaptures.get(request.url) || [];
  requests.push(request);
  pendingManualCaptures.set(request.url, requests);
}

function takeManualCapture(url) {
  const requests = pendingManualCaptures.get(url);
  if (!requests?.length) return null;
  const request = requests.shift();
  if (requests.length === 0) pendingManualCaptures.delete(url);
  if (typeof request.tabId === "number") {
    activeManualCaptureTabs.set(request.tabId, (activeManualCaptureTabs.get(request.tabId) || 0) + 1);
  }
  return request;
}

function finishManualCapture(request) {
  if (typeof request?.tabId !== "number") return;
  const count = activeManualCaptureTabs.get(request.tabId) || 0;
  if (count <= 1) activeManualCaptureTabs.delete(request.tabId);
  else activeManualCaptureTabs.set(request.tabId, count - 1);
}

function removeManualCapture(request) {
  const requests = pendingManualCaptures.get(request.url);
  if (!requests) return;
  const index = requests.indexOf(request);
  if (index >= 0) requests.splice(index, 1);
  if (requests.length === 0) pendingManualCaptures.delete(request.url);
}

function hasPendingManualCapture(tabId) {
  if (typeof tabId !== "number") return false;
  if (activeManualCaptureTabs.has(tabId)) return true;
  for (const requests of pendingManualCaptures.values()) {
    if (requests.some((request) => request.tabId === tabId)) return true;
  }
  return false;
}

B.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.linkUrl || info.srcUrl || info.selectionText;
  if (!isHandoffable(url)) {
    notify("Nothing to download", "That link isn't a direct file WingHarness can fetch.");
    return;
  }

  const request = { url, referrer: tab?.url, tabId: tab?.id };
  queueManualCapture(request);
  B.downloads.download({ url }).catch((error) => {
    removeManualCapture(request);
    notify("Couldn't start the browser download", String(error));
  });
});

// ---- Captures that precede a browser download ----------------------------

// Firefox can cancel an attachment response before creating a browser download,
// so that path still needs to hand the original response URL back on failure.
async function captureAndFallback(url, referrer, tabId, filename) {
  const outcome = await capture({ url, referrer, tabId, filename });
  if (outcome === "handed") return;
  bypass.add(url);
  B.downloads.download({ url }).catch(() => bypass.delete(url));
}

// ---- Firefox: catch server-driven downloads before the save dialog ------

// Firefox keeps blocking webRequest in MV3, so it can cancel a download the
// server triggers (Content-Disposition: attachment) before the browser's dialog.
// Chrome MV3 removed this for store extensions, so the manifest gates it: only the
// Firefox build declares `webRequestBlocking`.
function setupResponseInterception() {
  const perms = B.runtime.getManifest().permissions || [];
  if (!perms.includes("webRequestBlocking") || !B.webRequest?.onHeadersReceived) return;
  B.webRequest.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"] },
    ["blocking", "responseHeaders"],
  );
}
setupResponseInterception();

function onHeadersReceived(details) {
  if (!cachedConfig.enabled || !cachedConfig.autoCapture) return {};
  // A context-menu request is already being tracked through downloads.onCreated;
  // do not capture the same Firefox attachment again at the response layer.
  if (hasPendingManualCapture(details.tabId)) return {};
  // Only GET downloads can be safely re-issued if the user declines; leave the
  // rest (POST form results, etc.) to the browser.
  if (details.method && details.method !== "GET") return {};
  if (!isHandoffable(details.url) || bypass.has(details.url)) return {};
  if (Date.now() < suppressAutoUntil) return {};
  const disposition = (details.responseHeaders || []).find(
    (h) => h.name.toLowerCase() === "content-disposition",
  );
  if (!disposition || !/attachment/i.test(disposition.value || "")) return {};

  // It's a download — take it and cancel the browser's copy, carrying the
  // Content-Disposition filename along.
  const name = contentDispositionName(disposition.value);
  captureAndFallback(details.url, details.documentUrl || details.originUrl, details.tabId, name);
  return { cancel: true };
}

// ---- Auto-intercept the browser's own downloads -------------------------

B.downloads.onCreated.addListener(async (item) => {
  const cfg = await loadConfig();
  const manual = takeManualCapture(item.url);
  try {
    if (!cfg.enabled || (!cfg.autoCapture && !manual)) return;
    if (!isHandoffable(item.url)) return;
    if (bypass.has(item.url)) {
      bypass.delete(item.url);
      return; // a fallback download we already chose to leave with the browser
    }
    if (!manual && Date.now() < suppressAutoUntil) return; // recently declined; stay quiet
    if (!manual && cfg.minBytes > 0 && item.fileSize > 0 && item.fileSize < cfg.minBytes) return;

    // The item URL can be the initial link, not the resource the browser reached
    // after redirects. Wait for finalUrl to settle before pausing and submitting.
    const url = await resolveDownloadUrl(item);
    if (!url || !isHandoffable(url)) {
      if (manual) {
        notify(
          "Couldn't resolve the final download URL",
          "The browser will continue this download. Try again after the page finishes redirecting.",
        );
      }
      return;
    }

    // Pause after resolving the final URL so the browser can complete redirects.
    // If the pause fails the download already finished or can't be stopped; leave
    // it with the browser rather than risk a duplicate transfer.
    const paused = await pause(item.id);
    if (!paused) return;

    const outcome = await capture({
      url,
      referrer: manual?.referrer || item.referrer,
      tabId: manual?.tabId,
      // The browser's chosen path is a nicer name than the URL's tail.
      filename: basename(item.filename),
    });

    if (outcome === "handed") {
      await cancel(item.id);
      await erase(item.id);
    } else {
      if (outcome === "declined") suppressAutoUntil = Date.now() + SUPPRESS_AFTER_DECLINE_MS;
      await resume(item.id);
    }
  } finally {
    finishManualCapture(manual);
  }
});

/** Wait for Chrome/Firefox to publish the post-redirect DownloadItem.finalUrl. */
async function resolveDownloadUrl(item) {
  let finalUrl = isHandoffable(item.finalUrl) ? item.finalUrl : item.url;
  let lastUrlChangeAt = Date.now();
  const deadline = Date.now() + FINAL_URL_TIMEOUT_MS;

  const onChanged = (delta) => {
    if (delta.id !== item.id || !isHandoffable(delta.finalUrl?.current)) return;
    if (delta.finalUrl.current !== finalUrl) {
      finalUrl = delta.finalUrl.current;
      lastUrlChangeAt = Date.now();
    }
  };
  B.downloads.onChanged.addListener(onChanged);

  try {
    while (Date.now() < deadline) {
      const [latest] = await B.downloads.search({ id: item.id });
      if (!latest) return null;

      const currentUrl = isHandoffable(latest.finalUrl) ? latest.finalUrl : latest.url;
      if (currentUrl && currentUrl !== finalUrl) {
        finalUrl = currentUrl;
        lastUrlChangeAt = Date.now();
      }

      if (latest.state === "complete") return finalUrl;
      const urlIsSettled = Date.now() - lastUrlChangeAt >= FINAL_URL_SETTLE_MS;
      if (urlIsSettled && (finalUrl !== item.url || latest.bytesReceived > 0)) return finalUrl;
      await sleep(100);
    }

    // If no response or redirect arrived in time, leave this download to the
    // browser instead of guessing that the original URL is the file URL.
    return null;
  } catch (e) {
    console.warn(`${LOG} could not resolve the final download URL`, e);
    return null;
  } finally {
    B.downloads.onChanged.removeListener(onChanged);
  }
}

// ---- The shared capture pipeline ----------------------------------------

/**
 * Try to hand `{ url, referrer }` to WingHarness. Returns:
 *   "handed"   — WingHarness accepted it
 *   "declined" — WingHarness was down and the user chose not to wait for it
 *   "failed"   — an error the user was notified about
 */
async function capture({ url, referrer, tabId, filename }) {
  const cfg = await loadConfig();
  if (!cfg.token) {
    notify(
      "WingHarness isn't set up",
      "Open the extension's options and paste WingHarness's access token.",
    );
    return "failed";
  }

  if (!(await pingApp(cfg))) {
    // There's no custom protocol to fire, so the prompt asks the user to start
    // WingHarness by hand and offers to wait for it.
    const wantsRetry = await askToRetry(url, tabId);
    if (!wantsRetry) return "declined";
    if (!(await waitForApp(cfg))) {
      notify(
        "WingHarness isn't running",
        "Start WingHarness, then try this download again.",
      );
      return "failed";
    }
  }

  try {
    await sendToApp(cfg, { url, referrer, filename });
    notify("Sent to WingHarness", filename || filenameFromUrl(url));
    return "handed";
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`${LOG} /add failed`, message);
    // A 401 means the paired token is stale — point the user at options.
    if (message.includes("401")) {
      notify(
        "WingHarness rejected the token",
        "Regenerate it in WingHarness and update the extension's options.",
      );
    } else {
      notify("Couldn't send to WingHarness", message);
    }
    return "failed";
  }
}

/** Poll WingHarness's `/ping` until it answers or we give up. */
async function waitForApp(cfg) {
  const deadline = Date.now() + RETRY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await pingApp(cfg)) return true;
    await sleep(400);
  }
  return false;
}

// ---- The "start WingHarness" prompt -------------------------------------

/**
 * Ask the user to start WingHarness and wait for it. Prefers an in-page prompt on
 * the originating (or active) tab so it appears over the page; falls back to a
 * popup window when the page can't host one (no content script yet, or a
 * restricted page like the new tab / a store page).
 */
async function askToRetry(url, tabId) {
  const file = filenameFromUrl(url);
  const target = await resolvePromptTab(tabId);
  if (target != null) {
    try {
      const res = await B.tabs.sendMessage(
        target,
        { type: "wingharness-show-prompt", file },
        { frameId: 0 },
      );
      if (res && typeof res.retry === "boolean") return res.retry;
    } catch {
      // No content script there — fall back to the window prompt below.
    }
  }
  return askToRetryWindow(file);
}

/** The originating tab id if usable, else the active tab, else null. */
async function resolvePromptTab(tabId) {
  if (typeof tabId === "number" && tabId >= 0) return tabId;
  try {
    const [tab] = await B.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id ?? null;
  } catch {
    return null;
  }
}

/** The popup-window prompt — the fallback when an in-page prompt isn't possible. */
function askToRetryWindow(file) {
  return new Promise((resolve) => {
    const promptUrl =
      B.runtime.getURL("src/prompt.html") + `?file=${encodeURIComponent(file)}`;

    B.windows
      .create({ url: promptUrl, type: "popup", width: 440, height: 260 })
      .then((win) => {
        let settled = false;
        const finish = (retry) => {
          if (settled) return;
          settled = true;
          B.runtime.onMessage.removeListener(onMessage);
          B.windows.onRemoved.removeListener(onRemoved);
          B.windows.remove(win.id).catch(() => {});
          resolve(retry);
        };
        const onMessage = (msg) => {
          // The prompt reports its own window id, which is more reliable than
          // `sender.tab` across browsers.
          if (msg?.type === "wingharness-prompt-decision" && msg.windowId === win.id) {
            finish(!!msg.retry);
          }
        };
        const onRemoved = (closedId) => {
          if (closedId === win.id) finish(false);
        };
        B.runtime.onMessage.addListener(onMessage);
        B.windows.onRemoved.addListener(onRemoved);
      })
      .catch(() => resolve(false));
  });
}

// ---- Small helpers ------------------------------------------------------

function notify(title, message) {
  B.notifications
    .create({
      type: "basic",
      iconUrl: B.runtime.getURL("icons/icon-128.png"),
      title,
      message: message || "",
    })
    .catch(() => {});
}

/** Best-effort display name from a URL — the last path segment, query stripped. */
function filenameFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : url;
  } catch {
    return url;
  }
}

const pause = (id) => B.downloads.pause(id).then(() => true).catch(() => false);
const resume = (id) => B.downloads.resume(id).catch(() => {});
const cancel = (id) => B.downloads.cancel(id).catch(() => {});
const erase = (id) => B.downloads.erase({ id }).catch(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

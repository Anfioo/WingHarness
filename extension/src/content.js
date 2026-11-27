// Adapted from moin (MIT), https://github.com/exxvius/moin — see PRIVACY.md.
//
// The browser must resolve the link before handing a download to WingHarness.
// A URL that looks like a file can still redirect to a landing page or an auth
// flow, so this script intentionally never intercepts link clicks. The
// background listens for the browser's actual download and uses its final URL.
//
// Loaded after i18n.js in the manifest's content_scripts, so `t` and
// `applyI18n` are already defined here.

(() => {
  const B = globalThis.browser ?? globalThis.chrome;

  // ---- In-page "start WingHarness" prompt -------------------------------
  // The background asks us to show this when WingHarness is down, so the prompt
  // appears over the page instead of in a separate popup window. The extension
  // can't launch the app, so the primary action is "I started it, try again".
  B.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "wingharness-show-prompt") return;
    showRetryPrompt(msg.file).then((retry) => sendResponse({ retry }));
    return true; // keep the channel open for the async answer
  });

  function showRetryPrompt(file) {
    return new Promise((resolve) => {
      // A shadow root keeps the page's CSS from bleeding into (or breaking) the
      // prompt, and vice versa.
      const host = document.createElement("div");
      host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
      host.setAttribute("lang", B.i18n.getUILanguage());
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = PROMPT_MARKUP;
      applyI18n(shadow);
      shadow.querySelector(".mark").src = B.runtime.getURL("icons/icon.svg");
      if (file) shadow.querySelector(".file").textContent = file;

      const done = (retry) => {
        document.removeEventListener("keydown", onKey, true);
        host.remove();
        resolve(retry);
      };
      const onKey = (e) => {
        if (e.key === "Escape") done(false);
      };

      shadow.querySelector("#wh-retry").addEventListener("click", () => done(true));
      shadow.querySelector("#wh-cancel").addEventListener("click", () => done(false));
      shadow.querySelector(".backdrop").addEventListener("click", (e) => {
        if (e.target === e.currentTarget) done(false);
      });
      document.addEventListener("keydown", onKey, true);

      (document.body || document.documentElement).appendChild(host);
    });
  }

  // Palette and type mirror src/theme.css (the desktop app's neutral shadcn
  // tokens), so the prompt belongs to WingHarness on any page and in either
  // color scheme.
  const PROMPT_MARKUP = `
    <style>
      :host {
        --wh-card: oklch(1 0 0);
        --wh-text: oklch(0.145 0 0);
        --wh-muted: oklch(0.556 0 0);
        --wh-border: oklch(0.922 0 0);
        --wh-ghost: oklch(0.97 0 0);
        --wh-primary: oklch(0.205 0 0);
        --wh-primary-text: oklch(0.985 0 0);
      }
      @media (prefers-color-scheme: dark) {
        :host {
          --wh-card: oklch(0.19 0 0);
          --wh-text: oklch(0.985 0 0);
          --wh-muted: oklch(0.708 0 0);
          --wh-border: oklch(0.269 0 0);
          --wh-ghost: oklch(0.269 0 0);
          --wh-primary: oklch(0.985 0 0);
          --wh-primary-text: oklch(0.205 0 0);
        }
      }
      .backdrop {
        position: fixed; inset: 0; display: flex; align-items: center;
        justify-content: center; background: rgb(0 0 0 / 0.45);
        font:
          14px/1.55 Inter, ui-sans-serif, system-ui, -apple-system,
          "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      .card {
        width: 380px; max-width: calc(100vw - 40px);
        background: var(--wh-card); color: var(--wh-text);
        border: 1px solid var(--wh-border); border-radius: 10px;
        padding: 22px 22px 18px; box-shadow: 0 18px 50px rgb(0 0 0 / 0.4);
      }
      .row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
      .mark { width: 34px; height: 34px; flex: none; border-radius: 8px; }
      h1 { margin: 0; font-size: 16px; font-weight: 600; }
      p { margin: 0 0 6px; color: var(--wh-muted); }
      .file {
        margin: 4px 0 18px; padding: 8px 12px; background: var(--wh-ghost);
        border-radius: 8px; font-size: 13px; word-break: break-all;
        max-height: 3.2em; overflow: hidden;
      }
      .actions { display: flex; gap: 10px; justify-content: flex-end; }
      button {
        min-height: 36px; padding: 0 14px; border-radius: 8px;
        border: 1px solid var(--wh-border); background: transparent;
        color: var(--wh-text); font: inherit; font-weight: 500; cursor: pointer;
      }
      button:hover { background: var(--wh-ghost); }
      button.primary {
        background: var(--wh-primary); border-color: var(--wh-primary);
        color: var(--wh-primary-text);
      }
      button.primary:hover { opacity: 0.9; }
      button:focus-visible { outline: 2px solid var(--wh-muted); outline-offset: 2px; }
      @media (prefers-reduced-motion: reduce) {
        * { transition: none !important; }
      }
    </style>
    <div class="backdrop">
      <div class="card" role="dialog" aria-modal="true">
        <div class="row">
          <img class="mark" alt="" />
          <h1 data-i18n="promptTitle">WingHarness isn't running</h1>
        </div>
        <p data-i18n="promptBody">Start WingHarness, then send it this download.</p>
        <div class="file" data-i18n="promptFallbackFile">this download</div>
        <div class="actions">
          <button id="wh-cancel" data-i18n="promptNotNow">Not now</button>
          <button id="wh-retry" class="primary" data-i18n="promptRetry">I started it</button>
        </div>
      </div>
    </div>`;
})();

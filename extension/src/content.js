// Adapted from moin (MIT), https://github.com/exxvius/moin — see PRIVACY.md.
//
// The browser must resolve the link before handing a download to WingHarness.
// A URL that looks like a file can still redirect to a landing page or an auth
// flow, so this script intentionally never intercepts link clicks. The
// background listens for the browser's actual download and uses its final URL.

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
      host.style.cssText =
        "all:initial;position:fixed;inset:0;z-index:2147483647;";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = PROMPT_MARKUP;
      shadow.querySelector(".mark").src = B.runtime.getURL("icons/icon-128.png");
      shadow.querySelector(".file").textContent = file || "this download";

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

  const PROMPT_MARKUP = `
    <style>
      .backdrop {
        position: fixed; inset: 0; display: flex; align-items: center;
        justify-content: center; background: rgba(6, 8, 12, 0.5);
        font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      }
      .card {
        width: 380px; max-width: calc(100vw - 40px);
        background: #171b23; color: #eef1f7;
        border: 1px solid #262c38; border-radius: 14px;
        padding: 22px 22px 18px; box-shadow: 0 18px 50px rgba(0,0,0,0.45);
      }
      .row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
      .mark { width: 34px; height: 34px; border-radius: 9px; }
      h1 { margin: 0; font-size: 16px; font-weight: 650; }
      p { margin: 0 0 6px; color: #9aa4b2; }
      .file {
        margin: 4px 0 18px; padding: 8px 12px; background: #222835;
        border-radius: 8px; font-size: 13px; word-break: break-all;
        max-height: 3.2em; overflow: hidden;
      }
      .actions { display: flex; gap: 10px; justify-content: flex-end; }
      button {
        font: inherit; font-weight: 600; padding: 9px 16px; border-radius: 9px;
        border: 1px solid #262c38; background: #222835; color: #eef1f7; cursor: pointer;
      }
      button.primary { background: #f5f5f7; border-color: #f5f5f7; color: #1d1d1f; }
      button:hover { filter: brightness(1.08); }
    </style>
    <div class="backdrop">
      <div class="card" role="dialog" aria-modal="true">
        <div class="row">
          <img class="mark" alt="" />
          <h1>WingHarness isn't running</h1>
        </div>
        <p>Start WingHarness, then send it this download.</p>
        <div class="file"></div>
        <div class="actions">
          <button id="wh-cancel">Not now</button>
          <button id="wh-retry" class="primary">I started it</button>
        </div>
      </div>
    </div>`;
})();

// Adapted from moin (MIT), https://github.com/exxvius/moin — see PRIVACY.md.
//
// The "start WingHarness" prompt window. Reports the user's choice back to the
// background worker (with this window's id so it can match the right prompt),
// then lets the worker close the window. There's no custom protocol to fire, so
// "I started it" only tells the worker to go and re-check the app.

const B = globalThis.browser ?? globalThis.chrome;

const params = new URLSearchParams(location.search);
const file = params.get("file");
if (file) document.getElementById("file").textContent = file;

async function decide(retry) {
  const win = await B.windows.getCurrent();
  B.runtime.sendMessage({ type: "wingharness-prompt-decision", retry, windowId: win.id });
}

document.getElementById("retry").addEventListener("click", () => decide(true));
document.getElementById("cancel").addEventListener("click", () => decide(false));

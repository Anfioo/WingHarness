// Adapted from moin (MIT), https://github.com/exxvius/moin — see PRIVACY.md.
//
// Options page logic. Reuses the globals from i18n.js (`t`, `applyI18n`) and
// shared.js (`B`, `loadConfig`, `saveConfig`, `verifyApp`), both loaded first.
// Settings save as they change.

const portEl = document.getElementById("port");
const tokenEl = document.getElementById("token");
const enabledEl = document.getElementById("enabled");
const autoEl = document.getElementById("autoCapture");
const testEl = document.getElementById("test");
const statusEl = document.getElementById("status");
const versionEl = document.getElementById("version");

document.documentElement.lang = B.i18n.getUILanguage();
applyI18n(document);
versionEl.textContent = `v${B.runtime.getManifest().version}`;

async function init() {
  const cfg = await loadConfig();
  portEl.value = String(cfg.port);
  tokenEl.value = cfg.token;
  enabledEl.checked = cfg.enabled;
  autoEl.checked = cfg.autoCapture;
}

function setStatus(key, kind) {
  statusEl.textContent = t(key);
  statusEl.className = `status ${kind ?? "muted"}`;
}

// Persist the port only when it's a valid TCP port; otherwise snap it back.
async function commitPort() {
  const n = Number(portEl.value);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) {
    await saveConfig({ port: n });
  } else {
    const cfg = await loadConfig();
    portEl.value = String(cfg.port);
  }
}

portEl.addEventListener("change", commitPort);
tokenEl.addEventListener("change", () => saveConfig({ token: tokenEl.value.trim() }));
enabledEl.addEventListener("change", () => saveConfig({ enabled: enabledEl.checked }));
autoEl.addEventListener("change", () => saveConfig({ autoCapture: autoEl.checked }));

testEl.addEventListener("click", async () => {
  await commitPort();
  const cfg = { port: Number(portEl.value), token: tokenEl.value.trim() };
  if (!cfg.token) {
    setStatus("statusPasteToken", "bad");
    return;
  }
  setStatus("statusTesting", "muted");
  const result = await verifyApp(cfg);
  if (result === "ok") setStatus("statusConnected", "ok");
  else if (result === "bad-token") setStatus("statusBadToken", "bad");
  else setStatus("statusUnreachable", "bad");
});

init();

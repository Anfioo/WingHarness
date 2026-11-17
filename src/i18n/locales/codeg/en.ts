const codeg = {
  tabs: {
    chat: "Chat",
    settings: "Settings",
  },
  page: {
    loading: "Loading Codeg…",
    starting: "Starting the Codeg server…",
    stopped: "The Codeg server is not running",
    failed: "The Codeg server could not start",
    hint: "Check the paths, the port and the data directory under Settings → Codeg (dev).",
    start: "Start server",
    stop: "Stop server",
    restart: "Restart server",
    reload: "Reload the page",
    devtools: "Open the page inspector",
    openFailed: "Could not open Codeg: {{message}}",
    openLinkFailed: "Could not open the link: {{message}}",
    languageFailed: "Could not set the Codeg language: {{message}}",
  },
  settings: {
    title: "Codeg (dev)",
    description:
      "Run Codeg alongside this app and embed it as its own webview: the app starts and owns codeg-server, and the Codeg page follows this app's appearance and language. Development only.",
    server: "Server",
    serverHint:
      "The app starts codeg-server on loopback and stops it when the app quits. A path or port change takes effect on the next start.",
    start: "Start",
    stop: "Stop",
    restart: "Restart",
    ready: "Ready",
    starting: "Starting",
    failed: "Failed",
    stopped: "Not started",
    paths: "Paths",
    pathsHint: "Where Codeg is built on this machine.",
    repoPath: "Codeg repository",
    staticDir: "Static site directory",
    staticDirHint: "The Next.js export the server serves. Rebuild it after changing Codeg.",
    serverPath: "codeg-server executable",
    serverPathHint:
      "Build it with cargo build --no-default-features --features server-bin --bin codeg-server.",
    port: "Port",
    dataDir: "Data directory",
    dataDirHint:
      "Left empty, Codeg uses the folder a standalone Codeg uses by default too, so both share one database.",
    restartHint: "Restart the server to apply a changed path or port.",
    token: "Access token",
    tokenHint:
      "Generated on first use and kept afterwards. The embedded page is signed in with it, so it never shows a login screen.",
    copy: "Copy",
    tokenCopied: "Token copied",
    log: "Server output",
    logEmpty: "Nothing yet.",
  },
};

export default codeg;

export default {
  title: "Runtimes",
  description:
    "Download and unpack the executables the Clash and FRP features run. The official archives are published by this project.",
  clash: {
    title: "Clash runtime",
    description: "The mihomo core and its Geo databases.",
  },
  frp: {
    title: "FRP runtime",
    description: "The official frpc executable. Other builds can still be imported from a file.",
  },
  official: "Official",
  status: {
    installed: "Installed",
    missing: "Not installed",
    checking: "Checking…",
  },
  version: "Version {{version}}",
  action: {
    official: "Install official",
    reinstall: "Reinstall official",
    url: "Install from URL",
    archive: "Install from archive",
    openDir: "Open folder",
    refresh: "Refresh",
  },
  hint: {
    archive: "Accepts .7z and .zip archives.",
  },
  dialog: {
    urlTitle: "Install from URL",
    urlDescription: "The URL must return a .7z or .zip archive whose root contains {{binary}}.",
    urlPlaceholder: "https://example.com/runtime.7z",
    install: "Download and install",
    cancel: "Cancel",
  },
  progress: {
    download: "Downloading…",
    extract: "Extracting…",
    write: "Writing files {{done}}/{{total}}…",
  },
  messages: {
    installed: "The {{name}} is installed.",
  },
  errors: {
    invalidUrl: "Enter an http(s) URL.",
    statusFailed: "Cannot read the runtime status: {{detail}}",
    installFailed: "Installation failed: {{detail}}",
    binaryMissing: "The archive does not contain {{binary}} at its root.",
  },
  frpHint: "This entry cannot be deleted. It only reports whether the official frpc is present.",
};

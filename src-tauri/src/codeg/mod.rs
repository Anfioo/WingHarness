//! Codeg — the third-party Codeg app, served by its own process.
//!
//! Codeg is a separate product with its own backend, so it is not ported here:
//! the app runs `codeg-server` as a child process, points it at a static export
//! and at a data directory of its own, and shows the page that process serves in
//! a child webview ([`webview`]).
//!
//! Two halves, deliberately independent:
//!
//! * [`server`] owns the process — validate the configured paths and port,
//!   spawn, poll until it answers, and kill the whole tree on stop and on exit.
//! * [`webview`] owns the page — the token, the theme and the "you are embedded"
//!   marker are written into the page's `localStorage` before its first script
//!   runs, so it neither asks for a login nor paints its default light theme
//!   for a frame.
//!
//! The server comes from one of two places, and [`server::Mode`] is the whole
//! difference between them:
//!
//! * **Installed** — the archive the app downloaded from the Codeg release and
//!   unpacked under the data directory, which is what a packaged app runs.
//!   [`install`] owns that folder, the manifest check and the write-back.
//! * **Dev** — a checkout the developer builds, at the paths in the settings.
//!   Its page and its settings partition are hidden in a packaged build.

pub mod install;
pub mod server;
pub mod webview;

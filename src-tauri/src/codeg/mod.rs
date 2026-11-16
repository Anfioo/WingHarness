//! Codeg（开发）—— the third-party Codeg app, served by its own process.
//!
//! Codeg is a separate product with its own backend, so it is not ported here:
//! the app starts `codeg-server` from the user's checkout as a child process,
//! points it at a static export and at a data directory of its own, and shows
//! the page that process serves in a child webview ([`super::webview`]).
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
//! Nothing here is packaged for release: the paths default to a developer
//! checkout under `D:\codeg` and the settings page is where they are changed.

pub mod server;
pub mod webview;

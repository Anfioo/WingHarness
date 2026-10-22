//! The app's theme presets and what they need at runtime.
//!
//! The presets themselves live in the frontend (`src/lib/theme/presets.json`) —
//! switching between them is a matter of writing CSS custom properties on the
//! document element. What the backend owns is the part a webview cannot do for
//! itself: fetching the themes' fonts and keeping them on disk.

pub mod fonts;

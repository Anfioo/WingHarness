//! Link-step manifest for this package's test binaries.
//!
//! The library pulls in the Tauri runtime, whose menu layer imports
//! `TaskDialogIndirect`. Test binaries carry no application manifest (the
//! shipped app gets one from tauri-build), so Windows resolves `comctl32.dll`
//! to the legacy v5 side-by-side identity, which lacks that export, and the
//! harness dies with STATUS_ENTRYPOINT_NOT_FOUND before running a single test.
//! Declaring the v6 dependency on this package's own link steps fixes that
//! without touching the application binary's manifest.

fn main() {
    #[cfg(windows)]
    println!(
        "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
         name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
         processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );
}

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Elevated helper processes are this same executable relaunched with a
    // `--systools-*-helper*` flag. They must run and exit before Tauri
    // initialises: no window, no webview, no plugin setup. A normal launch
    // returns `None` and falls through.
    if let Some(code) = systools_core::helper::run_from_args(std::env::args_os()) {
        std::process::exit(code);
    }

    wingharness_lib::run()
}

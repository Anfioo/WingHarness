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

    // The privileged service, its UAC install helper and the uninstaller's
    // removal entry point are also this executable relaunched with an
    // `--argus-*` flag. They must run before Tauri initialises, or the service
    // would start a GUI and the helpers would never return an exit code.
    if let Some(code) = argus_service::run_mode() {
        std::process::exit(code);
    }

    wingharness_lib::run()
}

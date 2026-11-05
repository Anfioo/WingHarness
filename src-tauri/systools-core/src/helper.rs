//! Single headless entry point for privileged helper modes.
//!
//! `main()` must call this before initializing Tauri. Returning `None` starts
//! the normal desktop application; every helper flag returns an exit code
//! instead, so a malformed elevated invocation can never open a window.

use std::ffi::OsString;

pub fn run_from_args<I, S>(args: I) -> Option<i32>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let args: Vec<OsString> = args.into_iter().map(Into::into).collect();
    let flag = args.get(1)?.to_string_lossy();
    if flag.starts_with("--systools-elevation-helper") {
        return Some(crate::platform::elevation::run_helper(&args));
    }
    if flag.starts_with("--systools-startup-helper") {
        return crate::platform::startup_helper::run(&args);
    }
    if flag.starts_with("--systools-system-settings-helper") {
        return crate::platform::system_settings_helper::run(&args);
    }
    if flag.starts_with("--systools-application-record-helper") {
        return crate::platform::windows::registration_removal::run(&args);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_normal_launch_is_not_claimed_and_helper_flags_never_fall_through() {
        assert_eq!(run_from_args(["Systools"]), None);
        assert_eq!(run_from_args(["Systools", "--unrelated"]), None);
        for flag in [
            "--systools-elevation-helper-v1",
            "--systools-startup-helper-v1",
            "--systools-system-settings-helper-v1",
            "--systools-application-record-helper-v1",
        ] {
            assert_eq!(run_from_args(["Systools", flag]), Some(70));
        }
    }
}

// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
//! In-process Windows integration. The hook only inspects native focus and queues work;
//! Shell COM runs on its own apartment so it can never stall keyboard delivery.
use std::{
    cell::Cell,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering},
        mpsc::{sync_channel, SyncSender},
        OnceLock,
    },
};
use tauri::{AppHandle, Manager};
use windows::{
    core::Interface,
    Win32::{
        Foundation::{E_NOTIMPL, HINSTANCE, HWND, LPARAM, LRESULT, S_FALSE, WPARAM},
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IDispatch,
                IServiceProvider, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
            },
            LibraryLoader::GetModuleHandleW,
            Threading::GetCurrentThreadId,
            Variant::{VARIANT, VARIANT_0, VARIANT_0_0, VARIANT_0_0_0, VT_I4},
        },
        UI::{
            Input::KeyboardAndMouse::GetAsyncKeyState,
            Shell::{
                IFolderView2, IShellBrowser, IShellItem, IShellWindows, IWebBrowserApp,
                SID_STopLevelBrowser, ShellWindows, SIGDN_FILESYSPATH, SVGIO_SELECTION,
                SVSI_DESELECTOTHERS, SVSI_ENSUREVISIBLE, SVSI_FOCUSED, SVSI_SELECT, SWC_DESKTOP,
                SWFO_NEEDDISPATCH,
            },
            WindowsAndMessaging::*,
        },
    },
};

use super::everything;
use super::shortcut;

/// Posted to the hook thread to re-read the enabled switch.
const WM_AGENT_RESYNC: u32 = WM_APP + 1;

static RUNNING: AtomicBool = AtomicBool::new(false);
static COM_READY: AtomicBool = AtomicBool::new(false);
static SOURCE_WINDOW: AtomicUsize = AtomicUsize::new(0);
static SOURCE_VIEW: AtomicUsize = AtomicUsize::new(0);
static NAV_GENERATION: AtomicUsize = AtomicUsize::new(0);
/// The id of the thread that owns the hook and its message loop.
static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
thread_local! { static READ_VIEW: Cell<usize> = const { Cell::new(0) }; }
static REQUESTS: OnceLock<SyncSender<(usize, bool)>> = OnceLock::new();

#[derive(Clone, Copy, Default)]
struct SpaceGesture {
    held: bool,
    pending: Option<(usize, bool)>,
}

impl SpaceGesture {
    fn keydown(&mut self, candidate: Option<(usize, bool)>) -> bool {
        if !self.held {
            self.held = true;
            self.pending = candidate;
        }
        self.pending.is_some()
    }

    fn keyup(&mut self) -> Option<(usize, bool)> {
        // Clear state BEFORE sending a request that can change window focus.
        self.held = false;
        self.pending.take()
    }
}

thread_local! { static SPACE: Cell<SpaceGesture> = const { Cell::new(SpaceGesture { held: false, pending: None }) }; }

pub fn is_running() -> bool {
    RUNNING.load(Ordering::Relaxed)
}

pub fn is_com_ready() -> bool {
    COM_READY.load(Ordering::Relaxed)
}

/// The hook thread re-reads the switch on this signal; the switch itself lives
/// in `agent::mod` so the command surface and the hook agree on one value.
pub fn set_enabled(_enabled: bool) {
    let thread = HOOK_THREAD.load(Ordering::SeqCst);
    if thread != 0 {
        unsafe {
            let _ = PostThreadMessageW(thread, WM_AGENT_RESYNC, WPARAM(0), LPARAM(0));
        }
    }
}

pub fn cancel_navigation() {
    NAV_GENERATION.fetch_add(1, Ordering::SeqCst);
}

pub fn hide_preview(app: &tauri::AppHandle) -> tauri::Result<()> {
    cancel_navigation();
    let Some(window) = app.get_webview_window(crate::agent::PREVIEW_WINDOW) else {
        return Ok(());
    };
    let source = HWND(SOURCE_WINDOW.swap(0, Ordering::Relaxed) as *mut _);
    let was_foreground = window
        .hwnd()
        .map(|handle| unsafe { GetForegroundWindow().0 == handle.0 })
        .unwrap_or(false);
    window.hide()?;
    // Explicitly return keyboard focus after closing. On blur, preserve the
    // other app the user chose instead of activating Explorer over it.
    if was_foreground && !source.0.is_null() && unsafe { IsWindow(Some(source)).as_bool() } {
        unsafe {
            let _ = SetForegroundWindow(source);
        }
    }
    Ok(())
}

pub fn start(app: AppHandle) {
    let (sender, receiver) = sync_channel::<(usize, bool)>(1);
    if REQUESTS.set(sender).is_err() {
        return;
    }
    std::thread::spawn(move || unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            return;
        }
        COM_READY.store(true, Ordering::Relaxed);
        while let Ok((handle, text)) = receiver.recv() {
            log::debug!("space_preview_selection_request");
            let foreground = HWND(handle as *mut _);
            // Focus was validated when the key was pressed. Rechecking child focus here
            // used to silently discard an accepted press during Explorer focus changes.
            if GetForegroundWindow() != foreground {
                log::debug!("space_preview_selection_cancelled reason=\"foreground changed\"");
                continue;
            }
            let paths = read_selection(
                || GetForegroundWindow() == foreground,
                || selected_paths(foreground),
                || std::thread::sleep(std::time::Duration::from_millis(30)),
            );
            match paths {
                Ok(paths) if !paths.is_empty() && GetForegroundWindow() == foreground => {
                    log::debug!("space_preview_selection_count={}", paths.len());
                    let source_view = READ_VIEW.get();
                    if app
                        .get_webview_window(crate::agent::PREVIEW_WINDOW)
                        .is_some()
                    {
                        let preview_app = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            // The COM result may have waited in the UI queue.
                            if GetForegroundWindow().0 as usize != handle {
                                log::debug!(
                                    "space_preview_selection_cancelled reason=\"foreground changed before show\""
                                );
                                return;
                            }
                            cancel_navigation();
                            SOURCE_VIEW.store(source_view, Ordering::Relaxed);
                            SOURCE_WINDOW.store(handle, Ordering::Relaxed);
                            crate::agent::show_preview_files(&preview_app, paths, text, true);
                        });
                    }
                }
                result => {
                    let message = match result {
                        Err(error) => error.message().to_owned(),
                        _ => "No regular file was selected.".to_owned(),
                    };
                    log::debug!("space_preview_selection_unavailable message={message}");
                }
            }
        }
    });
    std::thread::spawn(move || unsafe {
        let thread = GetCurrentThreadId();
        HOOK_THREAD.store(thread, Ordering::SeqCst);
        let module = GetModuleHandleW(None).ok().map(HINSTANCE::from);
        let mut hook = None;
        resync_hook(&mut hook, module);
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).0 > 0 {
            if message.message == WM_AGENT_RESYNC {
                resync_hook(&mut hook, module);
                continue;
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        if let Some(hook) = hook {
            let _ = UnhookWindowsHookEx(hook);
        }
        RUNNING.store(false, Ordering::Relaxed);
        HOOK_THREAD.store(0, Ordering::SeqCst);
    });
}

/// Install or uninstall the hook to match the enabled switch.
unsafe fn resync_hook(hook: &mut Option<HHOOK>, module: Option<HINSTANCE>) {
    if crate::agent::is_enabled() {
        if hook.is_none() {
            match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), module, 0) {
                Ok(installed) => {
                    *hook = Some(installed);
                    RUNNING.store(true, Ordering::Relaxed);
                }
                Err(error) => log::warn!("space_preview_hook_install_failed error={error}"),
            }
        }
    } else if let Some(installed) = hook.take() {
        let _ = UnhookWindowsHookEx(installed);
        RUNNING.store(false, Ordering::Relaxed);
    }
}

/// Stop the hook and its message loop. Safe to call more than once.
pub fn stop() {
    cancel_navigation();
    let thread = HOOK_THREAD.swap(0, Ordering::SeqCst);
    if thread != 0 {
        unsafe {
            let _ = PostThreadMessageW(thread, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
    RUNNING.store(false, Ordering::Relaxed);
}

fn variant_i32(value: i32) -> VARIANT {
    VARIANT {
        Anonymous: VARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(VARIANT_0_0 {
                vt: VT_I4,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: VARIANT_0_0_0 { lVal: value },
            }),
        },
    }
}

unsafe fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 128];
    let length = GetClassNameW(hwnd, &mut buffer);
    String::from_utf16_lossy(&buffer[..length.max(0) as usize])
}

unsafe fn file_list_has_focus(foreground: HWND) -> bool {
    if everything::is_window_class(&class_name(foreground)) {
        return focused_window(foreground)
            .is_some_and(|focus| everything::has_list_focus(foreground, focus));
    }
    if !matches!(
        class_name(foreground).as_str(),
        "CabinetWClass" | "ExploreWClass" | "Progman" | "WorkerW"
    ) {
        return false;
    }
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    if GetGUIThreadInfo(GetWindowThreadProcessId(foreground, None), &mut info).is_err() {
        return false;
    }
    // A Shell list can retain a caret after focus returns from the preview.
    // Only the focused control and its ancestry determine whether this is a file list.
    // Edit/address/search controls and the navigation tree retain normal Space input.
    if !matches!(
        class_name(info.hwndFocus).as_str(),
        "DirectUIHWND" | "SysListView32" | "SHELLDLL_DefView"
    ) {
        return false;
    }
    let mut current = info.hwndFocus;
    for _ in 0..12 {
        if class_name(current) == "SHELLDLL_DefView" {
            return true;
        }
        if current == foreground {
            break;
        }
        current = match GetParent(current) {
            Ok(parent) => parent,
            Err(_) => break,
        };
    }
    false
}

unsafe extern "system" fn keyboard_hook(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 {
        let key = &*(data.0 as *const KBDLLHOOKSTRUCT);
        let config = shortcut::current();
        if key.vkCode == config & 255 {
            #[cfg(debug_assertions)]
            {
                let foreground = GetForegroundWindow();
                let mut info = GUITHREADINFO {
                    cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                    ..Default::default()
                };
                let _ = GetGUIThreadInfo(GetWindowThreadProcessId(foreground, None), &mut info);
                log::debug!(
                    "space_preview_key message={} time={} flags={} held={} pending={} foreground={:?} class={} focus={} eligible={} enabled={}",
                    message.0,
                    key.time,
                    key.flags.0,
                    SPACE.get().held,
                    SPACE.get().pending.is_some(),
                    foreground,
                    class_name(foreground),
                    class_name(info.hwndFocus),
                    file_list_has_focus(foreground),
                    crate::agent::is_enabled()
                );
            }
            if message.0 == WM_KEYUP as usize || message.0 == WM_SYSKEYUP as usize {
                let mut gesture = SPACE.get();
                let pending = gesture.keyup();
                SPACE.set(gesture);
                if let Some(request) = pending {
                    if crate::agent::is_enabled() {
                        if let Some(sender) = REQUESTS.get() {
                            let queued = sender.try_send(request);
                            log::debug!("space_preview_release_queued={}", queued.is_ok());
                        }
                    }
                    return LRESULT(1);
                }
            } else if message.0 == WM_KEYDOWN as usize || message.0 == WM_SYSKEYDOWN as usize {
                let foreground = GetForegroundWindow();
                let eligible = crate::agent::is_enabled()
                    && shortcut::matches(
                        config,
                        GetAsyncKeyState(0x11) < 0,
                        GetAsyncKeyState(0x12) < 0,
                        GetAsyncKeyState(0x5B) < 0 || GetAsyncKeyState(0x5C) < 0,
                    )
                    && file_list_has_focus(foreground);
                let candidate =
                    eligible.then(|| (foreground.0 as usize, GetAsyncKeyState(0x10) < 0));
                let mut gesture = SPACE.get();
                let suppress = gesture.keydown(candidate);
                SPACE.set(gesture);
                if suppress {
                    return LRESULT(1);
                }
            }
        }
    }
    CallNextHookEx(None, code, message, data)
}

unsafe fn focused_window(foreground: HWND) -> Option<HWND> {
    let mut info = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    GetGUIThreadInfo(GetWindowThreadProcessId(foreground, None), &mut info).ok()?;
    (!info.hwndFocus.0.is_null()).then_some(info.hwndFocus)
}

unsafe fn folder_from_browser(
    dispatch: IDispatch,
    foreground: HWND,
    desktop: bool,
) -> windows::core::Result<Option<(IFolderView2, HWND)>> {
    if !desktop {
        let browser: IWebBrowserApp = dispatch.cast()?;
        if browser.HWND()?.0 != foreground.0 as isize {
            return Ok(None);
        }
    }
    let provider: IServiceProvider = dispatch.cast()?;
    let browser: IShellBrowser = provider.QueryService(&SID_STopLevelBrowser)?;
    let view = browser.QueryActiveShellView()?;
    let view_window = view.GetWindow()?;
    if !IsWindowVisible(view_window).as_bool() {
        return Ok(None);
    }
    if !desktop && !IsChild(foreground, view_window).as_bool() {
        return Ok(None);
    }
    let folder: IFolderView2 = view.cast()?;
    Ok(Some((folder, view_window)))
}

unsafe fn paths_from_browser(
    dispatch: IDispatch,
    foreground: HWND,
    desktop: bool,
) -> windows::core::Result<Vec<String>> {
    let Some((folder, view_window)) = folder_from_browser(dispatch, foreground, desktop)? else {
        return Ok(Vec::new());
    };
    // Capture only the tab holding keyboard focus. Navigation later uses this
    // captured view while our preview window owns foreground focus.
    if !desktop
        && !focused_window(foreground)
            .is_some_and(|focus| focus == view_window || IsChild(view_window, focus).as_bool())
    {
        return Ok(Vec::new());
    }
    READ_VIEW.set(view_window.0 as usize);
    if folder.ItemCount(SVGIO_SELECTION)? == 0 {
        return Ok(Vec::new());
    }
    let items = folder.GetSelection(false)?;
    let mut paths = Vec::new();
    let count = items.GetCount()?;
    let mut directories = 0;
    let mut filesystem_items = 0;
    for index in 0..count.min(100) {
        let item = items.GetItemAt(index)?;
        if let Ok(raw) = item.GetDisplayName(SIGDN_FILESYSPATH) {
            let path = raw.to_string();
            CoTaskMemFree(Some(raw.0.cast()));
            if let Ok(path) = path {
                filesystem_items += 1;
                if Path::new(&path).is_file() {
                    paths.push(path);
                } else if Path::new(&path).is_dir() {
                    directories += 1;
                    paths.push(path);
                }
            }
        }
    }
    log::debug!(
        "space_preview_shell_selection items={count} paths={} directories={directories} filesystem_items={filesystem_items}",
        paths.len()
    );
    if paths.is_empty() && count > 0 {
        let message = if filesystem_items == 0 {
            "The selection has no local file path; these shell items cannot be previewed."
        } else {
            "The selected files no longer exist or cannot be read."
        };
        return Err(windows::core::Error::new(E_NOTIMPL, message));
    }
    Ok(paths)
}

unsafe fn selected_paths(foreground: HWND) -> windows::core::Result<Vec<String>> {
    if everything::is_window_class(&class_name(foreground)) {
        READ_VIEW.set(0);
        let (paths, list) = everything::selected_paths(foreground)?;
        READ_VIEW.set(list.0 as usize);
        return Ok(paths);
    }
    let shell: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL)?;
    if matches!(class_name(foreground).as_str(), "Progman" | "WorkerW") {
        let mut handle = 0;
        let desktop = shell.FindWindowSW(
            &variant_i32(0), // CSIDL_DESKTOP
            &VARIANT::default(),
            SWC_DESKTOP,
            &mut handle,
            SWFO_NEEDDISPATCH,
        )?;
        return paths_from_browser(desktop, foreground, true);
    }
    let mut selection_error = None;
    for index in 0..shell.Count()? {
        if let Ok(dispatch) = shell.Item(&variant_i32(index)) {
            match paths_from_browser(dispatch, foreground, false) {
                Ok(paths) if !paths.is_empty() => return Ok(paths),
                Err(error) => selection_error = Some(error),
                _ => (),
            }
        }
    }
    selection_error.map_or_else(|| Ok(Vec::new()), Err)
}

// Explorer can publish a new selection just after a click. Retry the same press
// briefly on the COM worker, never on the keyboard hook, and stop if the user leaves.
fn read_selection(
    mut still_current: impl FnMut() -> bool,
    mut read: impl FnMut() -> windows::core::Result<Vec<String>>,
    mut pause: impl FnMut(),
) -> windows::core::Result<Vec<String>> {
    for attempt in 0..4 {
        if !still_current() {
            return Ok(Vec::new());
        }
        let result = read();
        if result.as_ref().is_ok_and(|paths| !paths.is_empty()) || attempt == 3 {
            return result;
        }
        pause();
    }
    unreachable!()
}

/// Move the file manager selection by one item and return the new path.
///
/// The preview window must own the foreground and still be bound to the view the
/// press was taken from, otherwise the move is refused with `Ok(None)`.
pub fn navigate(
    app: AppHandle,
    current: Option<String>,
    direction: i32,
) -> windows::core::Result<Option<String>> {
    let generation = NAV_GENERATION.load(Ordering::SeqCst);
    let source = SOURCE_WINDOW.load(Ordering::Relaxed);
    let source_view = SOURCE_VIEW.load(Ordering::Relaxed);
    if source == 0 || source_view == 0 {
        return Ok(None);
    }
    let window = app
        .get_webview_window(crate::agent::PREVIEW_WINDOW)
        .ok_or_else(|| {
            windows::core::Error::new(E_NOTIMPL, "The preview window is not available.")
        })?;
    let preview = window
        .hwnd()
        .map_err(|error| {
            windows::core::Error::new(
                E_NOTIMPL,
                format!("The preview window has no native handle: {error}"),
            )
        })?
        .0 as usize;
    let current = current.map(std::path::PathBuf::from);

    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                unsafe { CoUninitialize() };
            }
        }
        let _apartment = Apartment;

        let valid = || {
            NAV_GENERATION.load(Ordering::SeqCst) == generation
                && SOURCE_WINDOW.load(Ordering::Relaxed) == source
                && SOURCE_VIEW.load(Ordering::Relaxed) == source_view
                && GetForegroundWindow().0 as usize == preview
        };
        let foreground = HWND(source as *mut _);
        if everything::is_window_class(&class_name(foreground)) {
            return everything::navigate(
                HWND(source_view as *mut _),
                current.as_deref(),
                direction,
                valid,
            );
        }

        let shell: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL)?;
        let desktop = matches!(class_name(foreground).as_str(), "Progman" | "WorkerW");
        let mut views = Vec::new();
        if desktop {
            let mut handle = 0;
            views.push(shell.FindWindowSW(
                &variant_i32(0),
                &VARIANT::default(),
                SWC_DESKTOP,
                &mut handle,
                SWFO_NEEDDISPATCH,
            )?);
        } else {
            for index in 0..shell.Count()? {
                if let Ok(view) = shell.Item(&variant_i32(index)) {
                    views.push(view);
                }
            }
        }
        let item_path = |item: &IShellItem| -> windows::core::Result<String> {
            let raw = item.GetDisplayName(SIGDN_FILESYSPATH)?;
            let result = raw.to_string();
            CoTaskMemFree(Some(raw.0.cast()));
            Ok(result?)
        };
        for dispatch in views {
            let Ok(Some((folder, view))) = folder_from_browser(dispatch, foreground, desktop) else {
                continue;
            };
            if view.0 as usize != source_view || !valid() {
                return Ok(None);
            }
            let index = folder.GetFocusedItem()?;
            let focused: IShellItem = folder.GetItem(index)?;
            if let Some(expected) = &current {
                if std::fs::canonicalize(item_path(&focused)?).ok().as_ref() != Some(expected) {
                    return Ok(None);
                }
            }
            // The generated wrapper discards S_FALSE; inspect it before using the index.
            let mut next = -1;
            let result = (Interface::vtable(&folder).GetVisibleItem)(
                Interface::as_raw(&folder),
                index,
                (direction < 0).into(),
                &mut next,
            );
            result.ok()?;
            if result == S_FALSE || next < 0 || next == index {
                return Ok(None);
            }
            let item: IShellItem = folder.GetItem(next)?;
            let next_path = item_path(&item)?;
            if !valid() {
                return Ok(None);
            }
            folder.SelectItem(
                next,
                (SVSI_SELECT.0 | SVSI_DESELECTOTHERS.0 | SVSI_FOCUSED.0 | SVSI_ENSUREVISIBLE.0)
                    as u32,
            )?;
            return Ok(Some(next_path));
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consecutive_previews_dispatch_once_on_release_and_reset_before_focus_changes() {
        let mut gesture = SpaceGesture::default();
        for source in [1, 2, 3, 4, 5] {
            assert!(gesture.keydown(Some((source, false))));
            // Holding Space must neither dispatch early nor replace the captured source.
            assert!(gesture.keydown(Some((99, true))));
            assert_eq!(gesture.keyup(), Some((source, false)));
            assert!(!gesture.held);
            assert_eq!(gesture.pending, None);
            // The preview can now appear/disappear without losing a required key-up.
            assert_eq!(gesture.keyup(), None);
        }
    }

    #[test]
    fn typing_and_closing_in_preview_do_not_arm_an_explorer_request() {
        let mut gesture = SpaceGesture::default();
        assert!(!gesture.keydown(None));
        assert!(!gesture.keydown(Some((1, false))));
        assert_eq!(gesture.keyup(), None);
        assert!(gesture.keydown(Some((2, true))));
        assert_eq!(gesture.keyup(), Some((2, true)));
    }

    #[test]
    fn one_press_waits_for_explorer_to_publish_selection() {
        let mut reads = 0;
        let paths = read_selection(
            || true,
            || {
                reads += 1;
                Ok(if reads < 3 {
                    vec![]
                } else {
                    vec!["next.txt".into()]
                })
            },
            || {},
        )
        .unwrap();
        assert_eq!(paths, vec!["next.txt"]);
        assert_eq!(reads, 3);
    }

    #[test]
    fn selection_retry_is_bounded_and_does_not_steal_focus() {
        let mut reads = 0;
        read_selection(
            || true,
            || {
                reads += 1;
                Ok(vec![])
            },
            || {},
        )
        .unwrap();
        assert_eq!(reads, 4);
        let active = Cell::new(true);
        let mut reads = 0;
        let paths = read_selection(
            || active.get(),
            || {
                reads += 1;
                Ok(vec![])
            },
            || active.set(false),
        )
        .unwrap();
        assert!(paths.is_empty());
        assert_eq!(reads, 1);
    }

    #[test]
    fn unrelated_windows_never_qualify_for_space_preview() {
        unsafe {
            assert!(!file_list_has_focus(HWND::default()));
        }
    }

    #[test]
    #[ignore = "requires an interactive Windows user session"]
    fn shell_com_and_keyboard_hook_are_available() {
        // Register a pass-through hook, never inject keys or modify Explorer selection.
        unsafe extern "system" fn passthrough(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
            CallNextHookEx(None, code, w, l)
        }
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).unwrap();
            let shell: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL).unwrap();
            assert!(shell.Count().unwrap() >= 0);
            let mut desktop_handle = 0;
            let desktop = shell
                .FindWindowSW(
                    &variant_i32(0),
                    &VARIANT::default(),
                    SWC_DESKTOP,
                    &mut desktop_handle,
                    SWFO_NEEDDISPATCH,
                )
                .unwrap();
            match paths_from_browser(desktop, HWND(desktop_handle as isize as *mut _), true) {
                Ok(paths) => println!(
                    "Desktop Shell connection ready; selected regular files: {}",
                    paths.len()
                ),
                Err(error) if error.code() == E_NOTIMPL => println!(
                    "Desktop Shell connection ready; selection is not a supported regular file"
                ),
                Err(error) => panic!("Desktop Shell connection failed: {error}"),
            }
            for index in 0..shell.Count().unwrap() {
                if let Ok(dispatch) = shell.Item(&variant_i32(index)) {
                    if let Ok(browser) = dispatch.cast::<IWebBrowserApp>() {
                        if let Ok(handle) = browser.HWND() {
                            let hwnd = HWND(handle.0 as *mut _);
                            let mut info = GUITHREADINFO {
                                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                                ..Default::default()
                            };
                            let _ =
                                GetGUIThreadInfo(GetWindowThreadProcessId(hwnd, None), &mut info);
                            println!(
                                "Shell view: window={}, focus={}, caret={}, eligible={}, selected_files={:?}",
                                class_name(hwnd),
                                class_name(info.hwndFocus),
                                !info.hwndCaret.0.is_null(),
                                file_list_has_focus(hwnd),
                                paths_from_browser(dispatch, hwnd, false)
                                    .map(|paths| paths.len())
                            );
                        }
                    }
                }
            }
            let module = GetModuleHandleW(None).unwrap();
            let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(passthrough), Some(module.into()), 0)
                .unwrap();
            UnhookWindowsHookEx(hook).unwrap();
            CoUninitialize();
        }
    }
}

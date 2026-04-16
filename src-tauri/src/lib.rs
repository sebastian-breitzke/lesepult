use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Serialize)]
struct FileResult {
    name: String,
    content: String,
    path: String,
}

fn read_md(path: &Path) -> Option<FileResult> {
    let content = std::fs::read_to_string(path).ok()?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let path_str = path.to_string_lossy().to_string();
    Some(FileResult {
        name,
        content,
        path: path_str,
    })
}

#[tauri::command]
async fn open_file_dialog() -> Option<FileResult> {
    let file = rfd::AsyncFileDialog::new()
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .pick_file()
        .await?;
    read_md(file.path())
}

fn resolve_path(raw: &str, base: Option<&str>) -> PathBuf {
    let p = PathBuf::from(raw);
    let resolved = if p.is_absolute() {
        p
    } else if let Some(base) = base {
        let base_path = PathBuf::from(base);
        let base_dir = base_path.parent().unwrap_or_else(|| Path::new(""));
        base_dir.join(&p)
    } else {
        p
    };
    std::fs::canonicalize(&resolved).unwrap_or(resolved)
}

/// Percent-encode a path for safe embedding in a URL fragment.
fn encode_for_url(s: &str) -> String {
    s.bytes()
        .flat_map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'/') {
                vec![b as char]
            } else {
                format!("%{:02X}", b).chars().collect()
            }
        })
        .collect()
}

/// Tracks which file (canonical path) each window currently displays.
/// Main window's entry is maintained by frontend via `set_window_file`;
/// reader-* windows are seeded at spawn time.
struct WindowFiles(Mutex<HashMap<String, String>>);

fn spawn_reader_window(app: &tauri::AppHandle, abs_path: &str) -> tauri::Result<()> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    let label = format!(
        "reader-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );

    if let Some(state) = app.try_state::<WindowFiles>() {
        state
            .0
            .lock()
            .unwrap()
            .insert(label.clone(), abs_path.to_string());
    }

    let url_path = format!("index.html#file={}", encode_for_url(abs_path));

    WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url_path.into()))
        .title("Lesepult")
        .inner_size(800.0, 1000.0)
        .center()
        .build()?;
    Ok(())
}

#[tauri::command]
fn open_md_window(
    app: tauri::AppHandle,
    path: String,
    base: Option<String>,
    state: tauri::State<WindowFiles>,
) -> Result<(), String> {
    use tauri::Manager;

    let resolved = resolve_path(&path, base.as_deref());
    if !resolved.exists() {
        return Err(format!("Not found: {}", resolved.display()));
    }
    let path_str = resolved.to_string_lossy().to_string();

    // If a window already displays this file, focus it instead of opening a new one.
    let existing_label = {
        let map = state.0.lock().unwrap();
        map.iter()
            .find(|(_, p)| p.as_str() == path_str)
            .map(|(l, _)| l.clone())
    };

    if let Some(label) = existing_label {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.unminimize();
            let _ = w.set_focus();
            return Ok(());
        }
        // Stale entry; drop it and fall through to spawn.
        state.0.lock().unwrap().remove(&label);
    }

    spawn_reader_window(&app, &path_str).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_window_file(
    window: tauri::Window,
    path: Option<String>,
    state: tauri::State<WindowFiles>,
) {
    let label = window.label().to_string();
    let mut map = state.0.lock().unwrap();
    match path {
        Some(p) => {
            // Store canonical path so focus-reuse matches regardless of how the
            // path was originally spelled (CLI, Finder, drag-drop, link-relative).
            let canonical = std::fs::canonicalize(&p)
                .map(|cp| cp.to_string_lossy().to_string())
                .unwrap_or(p);
            map.insert(label, canonical);
        }
        None => {
            map.remove(&label);
        }
    }
}

#[tauri::command]
fn read_file_at_path(path: String) -> Result<FileResult, String> {
    read_md(&PathBuf::from(&path)).ok_or_else(|| format!("Cannot read {path}"))
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

struct PendingFile(Mutex<Option<String>>);

#[tauri::command]
fn get_initial_file(state: tauri::State<PendingFile>) -> Option<FileResult> {
    // Check path stored by RunEvent::Opened (macOS file association)
    if let Some(path) = state.0.lock().unwrap().take() {
        let p = PathBuf::from(&path);
        if p.exists() {
            return read_md(&p);
        }
    }
    // Fallback: CLI args
    std::env::args()
        .skip(1)
        .find(|a| a.ends_with(".md") || a.ends_with(".markdown"))
        .and_then(|a| {
            let p = PathBuf::from(&a);
            if p.exists() { read_md(&p) } else { None }
        })
}

// ─── macOS Share Sheet ───────────────────────────────────────

#[cfg(target_os = "macos")]
mod macos_share {
    use std::ffi::{c_char, c_void, CString};

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct CGPoint { x: f64, y: f64 }
    #[repr(C)]
    #[derive(Copy, Clone)]
    struct CGSize { width: f64, height: f64 }
    #[repr(C)]
    #[derive(Copy, Clone)]
    struct CGRect { origin: CGPoint, size: CGSize }

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> *mut c_void;
        fn sel_registerName(name: *const c_char) -> *mut c_void;
        fn objc_msgSend();
    }

    macro_rules! sel {
        ($name:expr) => {
            sel_registerName(concat!($name, "\0").as_ptr() as *const c_char)
        };
    }

    macro_rules! cls {
        ($name:expr) => {
            objc_getClass(concat!($name, "\0").as_ptr() as *const c_char)
        };
    }

    /// Show the native macOS share picker for a file.
    /// `ns_view` must be a valid NSView pointer. Must be called on the main thread.
    pub unsafe fn show_picker(ns_view: *mut c_void, file_path: &str) {
        let c_path = CString::new(file_path).unwrap();

        // NSString from path
        type MsgSend1 = unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_char) -> *mut c_void;
        let string_with_utf8: MsgSend1 = std::mem::transmute(objc_msgSend as *const ());
        let path_ns = string_with_utf8(cls!("NSString"), sel!("stringWithUTF8String:"), c_path.as_ptr());

        // NSURL from path string
        type MsgSendObj = unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> *mut c_void;
        let msg_obj: MsgSendObj = std::mem::transmute(objc_msgSend as *const ());
        let url = msg_obj(cls!("NSURL"), sel!("fileURLWithPath:"), path_ns);

        // NSArray with the URL
        let items = msg_obj(cls!("NSArray"), sel!("arrayWithObject:"), url);

        // NSSharingServicePicker alloc + initWithItems:
        type MsgSendVoid = unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void;
        let msg_void: MsgSendVoid = std::mem::transmute(objc_msgSend as *const ());
        let picker = msg_void(cls!("NSSharingServicePicker"), sel!("alloc"));
        let picker = msg_obj(picker, sel!("initWithItems:"), items);

        // showRelativeToRect:ofView:preferredEdge:
        type ShowFn = unsafe extern "C" fn(*mut c_void, *mut c_void, CGRect, *mut c_void, usize);
        let show: ShowFn = std::mem::transmute(objc_msgSend as *const ());
        let rect = CGRect {
            origin: CGPoint { x: 0.0, y: 0.0 },
            size: CGSize { width: 1.0, height: 1.0 },
        };
        show(picker, sel!("showRelativeToRect:ofView:preferredEdge:"), rect, ns_view, 2);
    }
}

#[tauri::command]
async fn share_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use tauri::Manager;

        let window = app
            .get_webview_window("main")
            .ok_or("no main window")?;
        let handle = window.window_handle().map_err(|e| e.to_string())?;
        let ns_view = match handle.as_raw() {
            RawWindowHandle::AppKit(h) => h.ns_view.as_ptr(),
            _ => return Err("not macOS".into()),
        };

        let ns_view_addr = ns_view as usize;
        let path_clone = path.clone();
        app.run_on_main_thread(move || unsafe {
            macos_share::show_picker(ns_view_addr as *mut std::ffi::c_void, &path_clone);
        })
        .map_err(|e| e.to_string())?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        return Err(format!("Share not supported on this platform ({})", path));
    }

    #[cfg(target_os = "macos")]
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::{Manager, RunEvent};

    let app = tauri::Builder::default()
        .manage(PendingFile(Mutex::new(None)))
        .manage(WindowFiles(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            open_file_dialog,
            read_file_at_path,
            get_initial_file,
            open_external,
            open_md_window,
            set_window_file,
            share_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Lesepult");

    app.run(|handle, event| {
        // Clean up window->file map when a window is destroyed so focus-reuse
        // does not target a closed window.
        if let RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } = &event
        {
            if let Some(state) = handle.try_state::<WindowFiles>() {
                state.0.lock().unwrap().remove(label);
            }
        }

        #[cfg(target_os = "macos")]
        if let RunEvent::Opened { urls } = event {
            for url in &urls {
                if let Ok(path) = url.to_file_path() {
                    let path_str = path.to_string_lossy().to_string();
                    // Resolve/canonicalize so the key matches what set_window_file stores.
                    let canonical = std::fs::canonicalize(&path)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or(path_str);

                    if handle.get_webview_window("main").is_some() {
                        // Warm launch: focus existing window for this file, or spawn a new one.
                        let existing_label = handle
                            .try_state::<WindowFiles>()
                            .and_then(|state| {
                                state
                                    .0
                                    .lock()
                                    .unwrap()
                                    .iter()
                                    .find(|(_, p)| p.as_str() == canonical)
                                    .map(|(l, _)| l.clone())
                            });

                        if let Some(label) = existing_label {
                            if let Some(w) = handle.get_webview_window(&label) {
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                                continue;
                            }
                        }
                        let _ = spawn_reader_window(handle, &canonical);
                    } else {
                        // Cold launch: stash for get_initial_file on the main window.
                        if let Some(state) = handle.try_state::<PendingFile>() {
                            *state.0.lock().unwrap() = Some(canonical);
                        }
                    }
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        { let _ = (handle, event); }
    });
}

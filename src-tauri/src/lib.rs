use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Serialize)]
struct FileResult {
    name: String,
    content: String,
    path: String,
}

fn read_md(path: &PathBuf) -> Option<FileResult> {
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
    read_md(&file.path().to_path_buf())
}

#[tauri::command]
fn read_file_at_path(path: String) -> Result<FileResult, String> {
    read_md(&PathBuf::from(&path)).ok_or_else(|| format!("Cannot read {path}"))
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
        let _ = (app, path);
        return Err("Share not supported on this platform".into());
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::{Emitter, Manager, RunEvent};

    let app = tauri::Builder::default()
        .manage(PendingFile(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            open_file_dialog,
            read_file_at_path,
            get_initial_file,
            share_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Lesepult");

    app.run(|handle, event| {
        if let RunEvent::Opened { urls } = event {
            for url in &urls {
                if let Ok(path) = url.to_file_path() {
                    let path_str = path.to_string_lossy().to_string();
                    // Store for get_initial_file (cold launch)
                    if let Some(state) = handle.try_state::<PendingFile>() {
                        *state.0.lock().unwrap() = Some(path_str.clone());
                    }
                    // Emit for frontend (warm launch / already loaded)
                    let _ = handle.emit("open-file", &path_str);
                    break;
                }
            }
        }
    });
}

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Serialize)]
struct FileResult {
    name: String,
    content: String,
    path: String,
    modified: u64,
    size: u64,
}

fn read_md(path: &Path) -> Option<FileResult> {
    let content = std::fs::read_to_string(path).ok()?;
    let meta = std::fs::metadata(path).ok();
    let modified = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = meta.map(|m| m.len()).unwrap_or(content.len() as u64);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let path_str = path.to_string_lossy().to_string();
    Some(FileResult { name, content, path: path_str, modified, size })
}

#[tauri::command]
async fn open_file_dialog() -> Vec<FileResult> {
    rfd::AsyncFileDialog::new()
        .add_filter("Markdown", &["md", "markdown", "txt"])
        .pick_files()
        .await
        .unwrap_or_default()
        .iter()
        .filter_map(|f| read_md(f.path()))
        .collect()
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
fn read_clipboard_text() -> Option<String> {
    arboard::Clipboard::new().ok()?.get_text().ok()
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| format!("Cannot write {path}: {e}"))
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

struct PendingFiles(Mutex<Vec<String>>);

#[tauri::command]
fn get_initial_file(state: tauri::State<PendingFiles>) -> Vec<FileResult> {
    // Drain paths stored by RunEvent::Opened (macOS file association)
    let pending: Vec<String> = std::mem::take(&mut *state.0.lock().unwrap());
    if !pending.is_empty() {
        return pending
            .iter()
            .filter_map(|p| read_md(&PathBuf::from(p)))
            .collect();
    }
    // Fallback: all .md/.markdown CLI args
    std::env::args()
        .skip(1)
        .filter(|a| a.ends_with(".md") || a.ends_with(".markdown"))
        .filter_map(|a| {
            let p = PathBuf::from(&a);
            if p.exists() { read_md(&p) } else { None }
        })
        .collect()
}

// ─── Default save dir ─────────────────────────────────────

#[tauri::command]
fn default_save_dir() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(format!("{home}/Desktop"))
}

#[tauri::command]
async fn pick_save_directory(start_dir: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if let Some(d) = start_dir {
        dialog = dialog.set_directory(d);
    }
    let folder = dialog.pick_folder().await;
    Ok(folder.map(|f| f.path().to_string_lossy().to_string()))
}

// ─── macOS Export (PDF / RTF) ─────────────────────────────

#[cfg(target_os = "macos")]
mod macos_export {
    use std::ffi::{c_char, c_void, CString};

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

    type Id = *mut c_void;

    unsafe fn ns_string(s: &str) -> Id {
        let c = CString::new(s).unwrap();
        type Fn1 = unsafe extern "C" fn(Id, Id, *const c_char) -> Id;
        let f: Fn1 = std::mem::transmute(objc_msgSend as *const ());
        f(cls!("NSString"), sel!("stringWithUTF8String:"), c.as_ptr())
    }

    unsafe fn msg0(receiver: Id, selector: Id) -> Id {
        type Fn0 = unsafe extern "C" fn(Id, Id) -> Id;
        let f: Fn0 = std::mem::transmute(objc_msgSend as *const ());
        f(receiver, selector)
    }

    unsafe fn msg1(receiver: Id, selector: Id, arg: Id) -> Id {
        type Fn = unsafe extern "C" fn(Id, Id, Id) -> Id;
        let f: Fn = std::mem::transmute(objc_msgSend as *const ());
        f(receiver, selector, arg)
    }

    unsafe fn msg1_bool(receiver: Id, selector: Id, arg: bool) {
        type Fn = unsafe extern "C" fn(Id, Id, u8);
        let f: Fn = std::mem::transmute(objc_msgSend as *const ());
        f(receiver, selector, if arg { 1 } else { 0 });
    }

    unsafe fn msg0_bool(receiver: Id, selector: Id) -> bool {
        type Fn = unsafe extern "C" fn(Id, Id) -> u8;
        let f: Fn = std::mem::transmute(objc_msgSend as *const ());
        f(receiver, selector) != 0
    }

    unsafe fn class_name(obj: Id) -> String {
        extern "C" {
            fn object_getClass(obj: Id) -> Id;
            fn class_getName(cls: Id) -> *const c_char;
        }
        let c = object_getClass(obj);
        let name = class_getName(c);
        if name.is_null() {
            return String::new();
        }
        std::ffi::CStr::from_ptr(name).to_string_lossy().to_string()
    }

    /// Recursively search a view tree for a WKWebView.
    pub unsafe fn find_wkwebview(view: Id) -> Option<Id> {
        if view.is_null() {
            return None;
        }
        if class_name(view).contains("WKWebView") {
            return Some(view);
        }
        let subs = msg0(view, sel!("subviews"));
        if subs.is_null() {
            return None;
        }
        type CountFn = unsafe extern "C" fn(Id, Id) -> usize;
        type AtFn = unsafe extern "C" fn(Id, Id, usize) -> Id;
        let count_fn: CountFn = std::mem::transmute(objc_msgSend as *const ());
        let at_fn: AtFn = std::mem::transmute(objc_msgSend as *const ());
        let n = count_fn(subs, sel!("count"));
        for i in 0..n {
            let sub = at_fn(subs, sel!("objectAtIndex:"), i);
            if let Some(found) = find_wkwebview(sub) {
                return Some(found);
            }
        }
        None
    }

    /// Render the given WKWebView to a PDF file via NSPrintOperation.
    /// Must run on the main thread.
    pub unsafe fn write_pdf(webview: Id, target_path: &str) -> Result<(), String> {
        // [[NSPrintInfo alloc] init]
        let info = msg0(cls!("NSPrintInfo"), sel!("alloc"));
        let info = msg0(info, sel!("init"));
        if info.is_null() {
            return Err("NSPrintInfo alloc failed".into());
        }

        // info.dictionary → NSMutableDictionary
        let dict = msg0(info, sel!("dictionary"));
        // setObject:NSPrintSaveJob forKey:NSPrintJobDisposition
        let save_job = ns_string("NSSaveJob");
        let job_key = ns_string("NSJobDisposition");
        type Set2 = unsafe extern "C" fn(Id, Id, Id, Id);
        let set: Set2 = std::mem::transmute(objc_msgSend as *const ());
        set(dict, sel!("setObject:forKey:"), save_job, job_key);

        let path_value = ns_string(target_path);
        let path_key = ns_string("NSSavePath");
        set(dict, sel!("setObject:forKey:"), path_value, path_key);

        // Margins: small uniform (matches macOS print defaults)
        // Skip — defaults are reasonable.

        // [WKWebView printOperationWithPrintInfo:info]
        let op = msg1(webview, sel!("printOperationWithPrintInfo:"), info);
        if op.is_null() {
            return Err("printOperationWithPrintInfo: returned nil".into());
        }
        msg1_bool(op, sel!("setShowsPrintPanel:"), false);
        msg1_bool(op, sel!("setShowsProgressPanel:"), false);

        let ok = msg0_bool(op, sel!("runOperation"));
        if !ok {
            return Err("PDF print operation failed".into());
        }
        Ok(())
    }

    /// Convert HTML to RTF and write to file. Must run on the main thread
    /// (NSAttributedString HTML init uses WebKit).
    pub unsafe fn write_rtf(html: &str, target_path: &str) -> Result<(), String> {
        // NSData *htmlData = [htmlString dataUsingEncoding:NSUTF8StringEncoding]
        let html_ns = ns_string(html);
        type DataEnc = unsafe extern "C" fn(Id, Id, usize) -> Id;
        let data_enc: DataEnc = std::mem::transmute(objc_msgSend as *const ());
        let html_data = data_enc(html_ns, sel!("dataUsingEncoding:"), 4); // NSUTF8StringEncoding = 4
        if html_data.is_null() {
            return Err("HTML data encoding failed".into());
        }

        // options dict: { NSDocumentTypeDocumentAttribute: NSHTMLTextDocumentType,
        //                 NSCharacterEncodingDocumentAttribute: NSUTF8StringEncoding }
        let opts = msg0(cls!("NSMutableDictionary"), sel!("dictionary"));
        let doc_type_key = ns_string("DocumentType");
        let html_type_val = ns_string("NSHTML");
        type Set2 = unsafe extern "C" fn(Id, Id, Id, Id);
        let set: Set2 = std::mem::transmute(objc_msgSend as *const ());
        set(opts, sel!("setObject:forKey:"), html_type_val, doc_type_key);

        // NSAttributedString *attr = [[NSAttributedString alloc] initWithData:options:documentAttributes:error:]
        let alloc_attr = msg0(cls!("NSAttributedString"), sel!("alloc"));
        type InitWithData = unsafe extern "C" fn(Id, Id, Id, Id, Id, Id) -> Id;
        let init_data: InitWithData = std::mem::transmute(objc_msgSend as *const ());
        let attr = init_data(
            alloc_attr,
            sel!("initWithData:options:documentAttributes:error:"),
            html_data,
            opts,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        );
        if attr.is_null() {
            return Err("NSAttributedString init from HTML failed".into());
        }

        // length = attr.length, range = (0, length)
        type LenFn = unsafe extern "C" fn(Id, Id) -> usize;
        let len_fn: LenFn = std::mem::transmute(objc_msgSend as *const ());
        let length = len_fn(attr, sel!("length"));

        // RTF document attributes
        let rtf_opts = msg0(cls!("NSMutableDictionary"), sel!("dictionary"));
        let rtf_type_val = ns_string("NSRTF");
        set(rtf_opts, sel!("setObject:forKey:"), rtf_type_val, doc_type_key);

        // [attr dataFromRange:(NSRange){0,length} documentAttributes:rtf_opts]
        #[repr(C)]
        struct NSRange {
            location: usize,
            length: usize,
        }
        let range = NSRange { location: 0, length };
        type DataFromRange =
            unsafe extern "C" fn(Id, Id, NSRange, Id, Id) -> Id;
        let data_from: DataFromRange = std::mem::transmute(objc_msgSend as *const ());
        let rtf_data = data_from(
            attr,
            sel!("dataFromRange:documentAttributes:error:"),
            range,
            rtf_opts,
            std::ptr::null_mut(),
        );
        if rtf_data.is_null() {
            return Err("RTF conversion failed".into());
        }

        // [data writeToFile:path atomically:YES]
        let path_ns = ns_string(target_path);
        type WriteToFile = unsafe extern "C" fn(Id, Id, Id, u8) -> u8;
        let write_fn: WriteToFile = std::mem::transmute(objc_msgSend as *const ());
        let ok = write_fn(rtf_data, sel!("writeToFile:atomically:"), path_ns, 1);
        if ok == 0 {
            return Err(format!("Cannot write {}", target_path));
        }
        Ok(())
    }

    /// Put a file URL on the general pasteboard so Cmd+V in Finder/Mail/Teams
    /// pastes the file as an attachment.
    pub unsafe fn copy_file_url_to_pasteboard(path: &str) {
        let pb = msg0(cls!("NSPasteboard"), sel!("generalPasteboard"));
        if pb.is_null() {
            return;
        }
        let _ = msg0(pb, sel!("clearContents"));

        let path_ns = ns_string(path);
        let url = msg1(cls!("NSURL"), sel!("fileURLWithPath:"), path_ns);
        if url.is_null() {
            return;
        }
        let arr = msg1(cls!("NSArray"), sel!("arrayWithObject:"), url);
        let _ = msg1(pb, sel!("writeObjects:"), arr);
    }
}

// ─── PDF / RTF export commands ────────────────────────────

#[tauri::command]
async fn export_pdf(
    app: tauri::AppHandle,
    target_path: String,
    include_metadata: bool,
    copy_path_to_clipboard: bool,
) -> Result<(), String> {
    let _ = include_metadata; // CSS class is set frontend-side; param kept for clarity

    #[cfg(target_os = "macos")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use tauri::Manager;

        let window = app
            .get_webview_window("main")
            .or_else(|| app.webview_windows().into_values().next())
            .ok_or("no window")?;
        let handle = window.window_handle().map_err(|e| e.to_string())?;
        let ns_view = match handle.as_raw() {
            RawWindowHandle::AppKit(h) => h.ns_view.as_ptr() as usize,
            _ => return Err("not macOS".into()),
        };

        let target = target_path.clone();
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        app.run_on_main_thread(move || unsafe {
            let view = ns_view as *mut std::ffi::c_void;
            match macos_export::find_wkwebview(view) {
                Some(wv) => {
                    let res = macos_export::write_pdf(wv, &target);
                    if res.is_ok() && copy_path_to_clipboard {
                        macos_export::copy_file_url_to_pasteboard(&target);
                    }
                    let _ = tx.send(res);
                }
                None => {
                    let _ = tx.send(Err("WKWebView not found in window".into()));
                }
            }
        })
        .map_err(|e| e.to_string())?;

        rx.recv().map_err(|e| e.to_string())??;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, target_path, copy_path_to_clipboard);
        Err("PDF-Export wird nur auf macOS unterstützt.".into())
    }
}

#[tauri::command]
async fn export_rtf(
    app: tauri::AppHandle,
    target_path: String,
    html: String,
    copy_path_to_clipboard: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let target = target_path.clone();
        let html_clone = html.clone();
        let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
        app.run_on_main_thread(move || unsafe {
            let res = macos_export::write_rtf(&html_clone, &target);
            if res.is_ok() && copy_path_to_clipboard {
                macos_export::copy_file_url_to_pasteboard(&target);
            }
            let _ = tx.send(res);
        })
        .map_err(|e| e.to_string())?;

        rx.recv().map_err(|e| e.to_string())??;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, target_path, html, copy_path_to_clipboard);
        Err("RTF-Export wird nur auf macOS unterstützt.".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::{Manager, RunEvent};

    let app = tauri::Builder::default()
        .manage(PendingFiles(Mutex::new(Vec::new())))
        .manage(WindowFiles(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            open_file_dialog,
            read_file_at_path,
            get_initial_file,
            open_external,
            open_md_window,
            set_window_file,
            read_clipboard_text,
            write_file,
            default_save_dir,
            pick_save_directory,
            export_pdf,
            export_rtf,
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
                        if let Some(state) = handle.try_state::<PendingFiles>() {
                            state.0.lock().unwrap().push(canonical);
                        }
                    }
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        { let _ = (handle, event); }
    });
}

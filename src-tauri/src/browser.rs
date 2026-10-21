//! Integrated browser: one native child webview laid over a cell of the terminal panel.
//!
//! The page is remote content: it gets no IPC (the capability file lists no `remote` URLs), and navigation
//! is limited to http(s). The frontend only reports where the cell is; the page itself never talks to it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::webview::{DownloadEvent, NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};
use tauri_plugin_dialog::DialogExt;

const LABEL: &str = "browser";

#[derive(serde::Serialize, Clone)]
struct BrowserUrl {
    url: String,
}

#[derive(serde::Serialize, Clone)]
struct BrowserTitle {
    title: String,
}

#[derive(serde::Serialize, Clone)]
struct BrowserDownload {
    message: String,
    error: bool,
}

static NEXT_DOWNLOAD: AtomicU64 = AtomicU64::new(0);

/// Temporary file of each running download, by URL (on macOS the finished event does not carry the path).
fn pending_downloads() -> &'static Mutex<HashMap<String, PathBuf>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// File name offered by the page, reduced to a plain name without separators or control characters.
fn download_name(suggested: &Path) -> String {
    let name: String = suggested
        .file_name()
        .map(|n| n.to_string_lossy().chars().filter(|c| !c.is_control()).collect())
        .unwrap_or_default();
    if name.is_empty() || name == "." || name == ".." { "download".into() } else { name }
}

/// A fresh file in the app cache where the download goes until the user picks the final place.
/// The save dialog cannot open inside the download hook (it must answer at once), so it opens when the download ends.
fn temp_download_path(app: &AppHandle, suggested: &Path) -> Option<PathBuf> {
    let id = NEXT_DOWNLOAD.fetch_add(1, Ordering::Relaxed);
    let dir = app.path().app_cache_dir().ok()?.join("downloads").join(format!("{}-{id}", std::process::id()));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(download_name(suggested)))
}

fn remove_temp(temp: &Path) {
    if let Some(dir) = temp.parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

fn notify_download(app: &AppHandle, message: String, error: bool) {
    let _ = app.emit("browser-download", BrowserDownload { message, error });
}

/// File name from the last segment of the URL, percent-decoded (`None` if it is empty or not a plain name).
fn name_from_url(url: &Url) -> Option<String> {
    let segment = url.path_segments()?.next_back()?;
    let bytes = segment.as_bytes();
    let mut raw = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = (bytes[i] == b'%' && i + 2 < bytes.len())
            .then(|| std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()))
            .flatten();
        match hex {
            Some(byte) => {
                raw.push(byte);
                i += 3;
            }
            None => {
                raw.push(bytes[i]);
                i += 1;
            }
        }
    }
    let name = download_name(Path::new(&String::from_utf8_lossy(&raw).into_owned()));
    (name != "download").then_some(name)
}

/// Asks where to save the finished download and moves it there.
/// `temp` is true when the file sits in our cache folder (a cancelled dialog discards it); otherwise WebKit
/// already wrote it to its own download folder and a cancelled dialog leaves it there.
fn finish_download(app: &AppHandle, file: PathBuf, temp: bool, name: String, success: bool) {
    if !success {
        if temp {
            remove_temp(&file);
        }
        notify_download(app, "Download failed".into(), true);
        return;
    }
    let done_app = app.clone();
    let mut dialog = app.dialog().file().set_file_name(&name);
    if let Some(dir) = file.parent().filter(|_| !temp) {
        dialog = dialog.set_directory(dir);
    }
    dialog.save_file(move |chosen| {
        match chosen.and_then(|p| p.into_path().ok()) {
            Some(target) if target == file => notify_download(&done_app, format!("Saved {}", target.display()), false),
            Some(target) => {
                let moved = std::fs::rename(&file, &target)
                    .or_else(|_| std::fs::copy(&file, &target).and_then(|_| std::fs::remove_file(&file)));
                match moved {
                    Ok(()) => notify_download(&done_app, format!("Saved {}", target.display()), false),
                    Err(e) => notify_download(&done_app, format!("{}: {e}", target.display()), true),
                }
            }
            None if !temp => notify_download(&done_app, format!("Saved {}", file.display()), false),
            None => {}
        }
        if temp {
            remove_temp(&file);
        }
    });
}

/// Parses what the user typed: a missing scheme means https, only http(s) is accepted.
fn parse_url(input: &str) -> Result<Url, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("empty address".into());
    }
    let with_scheme = if text.contains("://") { text.to_string() } else { format!("https://{text}") };
    let url = Url::parse(&with_scheme).map_err(|e| format!("{text}: {e}"))?;
    match url.scheme() {
        "http" | "https" if url.host_str().is_some() => Ok(url),
        _ => Err(format!("{text}: only http and https addresses are allowed")),
    }
}

#[cfg(not(target_os = "linux"))]
fn bounds(x: f64, y: f64, width: f64, height: f64) -> tauri::Rect {
    tauri::Rect {
        position: LogicalPosition::new(x, y).into(),
        size: LogicalSize::new(width.max(1.0), height.max(1.0)).into(),
    }
}

/// Moves and sizes the view. Tauri packs a child webview into the window's GtkBox on Linux, below the status bar,
/// and ignores its position: the view goes into a GtkOverlay over the main webview, placed with margins.
#[cfg(target_os = "linux")]
fn place(app: &AppHandle, view: &tauri::Webview, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    use gtk::prelude::*;
    use std::cell::RefCell;
    thread_local! {
        /// The main webview widget, filled by the closure below (both closures run on the GTK thread, in order).
        static MAIN: RefCell<Option<gtk::Widget>> = const { RefCell::new(None) };
    }
    let (x, y) = (x.round() as i32, y.round() as i32);
    let (width, height) = (width.round().max(1.0) as i32, height.round().max(1.0) as i32);
    if let Some(main) = app.get_webview("main") {
        main.with_webview(|platform| MAIN.with(|slot| *slot.borrow_mut() = Some(platform.inner().upcast())))
            .map_err(|e| e.to_string())?;
    }
    view.with_webview(move |platform| {
        let widget: gtk::Widget = platform.inner().upcast();
        let main = MAIN.with(|slot| slot.borrow().clone());
        let Some(main) = main else { return };
        // the main webview moves into the overlay on the first use and stays there
        let overlay = match main.parent() {
            Some(parent) if parent.is::<gtk::Overlay>() => parent.downcast::<gtk::Overlay>().ok(),
            Some(parent) => parent.downcast::<gtk::Box>().ok().map(|vbox| {
                let overlay = gtk::Overlay::new();
                vbox.remove(&main);
                overlay.add(&main);
                vbox.pack_start(&overlay, true, true, 0);
                overlay
            }),
            None => None,
        };
        let Some(overlay) = overlay else { return };
        match widget.parent() {
            Some(parent) if parent == overlay => {}
            Some(parent) => {
                if let Ok(container) = parent.downcast::<gtk::Container>() {
                    container.remove(&widget);
                }
                overlay.add_overlay(&widget);
            }
            None => overlay.add_overlay(&widget),
        }
        // margins on all four sides: the view fills what is left, so a loaded page cannot make it larger than its cell
        widget.set_halign(gtk::Align::Fill);
        widget.set_valign(gtk::Align::Fill);
        widget.set_margin_start(x);
        widget.set_margin_top(y);
        widget.set_margin_end((overlay.allocated_width() - x - width).max(0));
        widget.set_margin_bottom((overlay.allocated_height() - y - height).max(0));
        widget.set_size_request(width, height);
        overlay.show_all();
    })
    .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "linux"))]
fn place(_app: &AppHandle, view: &tauri::Webview, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    view.set_bounds(bounds(x, y, width, height)).map_err(|e| e.to_string())
}

/// Creates the webview at the given cell rectangle (CSS pixels, relative to the window) or moves the existing one.
#[tauri::command]
pub fn browser_show(app: AppHandle, url: Option<String>, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if let Some(view) = app.get_webview(LABEL) {
        place(&app, &view, x, y, width, height)?;
        return view.show().map_err(|e| e.to_string());
    }
    let start = match url {
        Some(text) => parse_url(&text)?,
        None => Url::parse("about:blank").map_err(|e| e.to_string())?,
    };
    let window = app.get_window("main").ok_or("main window not found")?;
    let nav_app = app.clone();
    let title_app = app.clone();
    let popup_app = app.clone();
    let download_app = app.clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(start))
        .on_navigation(move |target| {
            let allowed = matches!(target.scheme(), "http" | "https") || target.as_str() == "about:blank";
            if allowed {
                let _ = nav_app.emit("browser-url", BrowserUrl { url: target.to_string() });
            }
            allowed
        })
        .on_document_title_changed(move |_, title| {
            let _ = title_app.emit("browser-title", BrowserTitle { title });
        })
        // target=_blank and window.open: load in the same view, never open a second window
        .on_new_window(move |target, _| {
            if let (Ok(url), Some(view)) = (parse_url(target.as_str()), popup_app.get_webview(LABEL)) {
                let _ = view.navigate(url);
            }
            NewWindowResponse::Deny
        })
        .on_download(move |_, event| match event {
            DownloadEvent::Requested { url, destination } => {
                match temp_download_path(&download_app, destination) {
                Some(temp) => {
                    pending_downloads().lock().unwrap().insert(url.to_string(), temp.clone());
                    *destination = temp;
                    true
                }
                None => false,
                }
            }
            DownloadEvent::Finished { url, path, success } => {
                let temp = pending_downloads().lock().unwrap().remove(url.as_str());
                match (temp, path) {
                    (Some(file), _) => {
                        let name = download_name(&file);
                        finish_download(&download_app, file, true, name, success);
                    }
                    // the destination hook did not run: WebKit saved the file in its own download folder
                    (None, Some(file)) => {
                        let name = name_from_url(&url).unwrap_or_else(|| download_name(&file));
                        finish_download(&download_app, file, false, name, success);
                    }
                    (None, None) => notify_download(&download_app, "Download failed".into(), true),
                }
                true
            }
            _ => true,
        });
    let view = window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|e| e.to_string())?;
    place(&app, &view, x, y, width, height)
}

#[tauri::command]
pub fn browser_bounds(app: AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    match app.get_webview(LABEL) {
        Some(view) => place(&app, &view, x, y, width, height),
        None => Ok(()),
    }
}

/// Hides the page without losing it (panel hidden, overlay on top).
#[tauri::command]
pub fn browser_hide(app: AppHandle) -> Result<(), String> {
    match app.get_webview(LABEL) {
        Some(view) => view.hide().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[tauri::command]
pub fn browser_close(app: AppHandle) -> Result<(), String> {
    match app.get_webview(LABEL) {
        Some(view) => view.close().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Loads an address typed in the bar; returns the normalised URL.
#[tauri::command]
pub fn browser_go(app: AppHandle, url: String) -> Result<String, String> {
    let parsed = parse_url(&url)?;
    let view = app.get_webview(LABEL).ok_or("browser not open")?;
    view.navigate(parsed.clone()).map_err(|e| e.to_string())?;
    Ok(parsed.to_string())
}

/// `back`, `forward` or `reload`.
#[tauri::command]
pub fn browser_nav(app: AppHandle, action: String) -> Result<(), String> {
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err(format!("{action}: unknown action")),
    };
    match app.get_webview(LABEL) {
        Some(view) => view.eval(script).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::{name_from_url, parse_url};
    use tauri::Url;

    #[test]
    fn download_name_comes_from_the_last_url_segment() {
        let name = |text: &str| name_from_url(&Url::parse(text).unwrap());
        assert_eq!(name("https://x.ch/d/s-nib_0.6.0_amd64.deb").as_deref(), Some("s-nib_0.6.0_amd64.deb"));
        assert_eq!(name("https://x.ch/a%20b.pdf?x=1").as_deref(), Some("a b.pdf"));
        assert_eq!(name("https://x.ch/..%2Fetc%2Fpasswd").as_deref(), Some("passwd"));
        assert_eq!(name("https://x.ch/"), None);
    }

    #[test]
    fn parse_url_accepts_only_http_and_adds_https() {
        assert_eq!(parse_url("example.com").unwrap().as_str(), "https://example.com/");
        assert_eq!(parse_url(" http://localhost:8080/a ").unwrap().as_str(), "http://localhost:8080/a");
        assert!(parse_url("").is_err());
        assert!(parse_url("file:///etc/passwd").is_err());
        assert!(parse_url("javascript:alert(1)").is_err());
        assert!(parse_url("ftp://example.com").is_err());
    }
}

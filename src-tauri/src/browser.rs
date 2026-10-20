//! Integrated browser: one native child webview laid over a cell of the terminal panel.
//!
//! The page is remote content: it gets no IPC (the capability file lists no `remote` URLs), and navigation
//! is limited to http(s). The frontend only reports where the cell is; the page itself never talks to it.

use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

const LABEL: &str = "browser";

#[derive(serde::Serialize, Clone)]
struct BrowserUrl {
    url: String,
}

#[derive(serde::Serialize, Clone)]
struct BrowserTitle {
    title: String,
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
    use super::parse_url;

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

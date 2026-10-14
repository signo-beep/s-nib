use std::fs;
use std::path::Path;

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Wry};

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "md" | "markdown" | "txt"))
        .unwrap_or(false)
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let read = fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))?;
    let mut entries = Vec::new();
    for item in read {
        let item = item.map_err(|e| format!("{path}: {e}"))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let p = item.path();
        let is_dir = p.is_dir();
        if !is_dir && !is_markdown(&p) {
            continue;
        }
        entries.push(DirEntry {
            name,
            path: p.to_string_lossy().into_owned(),
            is_dir,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("{path}: {e}"))
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, label: &str, accel: Option<&str>| {
        let mut builder = MenuItemBuilder::with_id(id, label);
        if let Some(accel) = accel {
            builder = builder.accelerator(accel);
        }
        builder.build(app)
    };

    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new", "Nuovo", Some("CmdOrCtrl+N"))?)
        .item(&item("open", "Apri...", Some("CmdOrCtrl+O"))?)
        .item(&item("open_folder", "Apri cartella...", Some("CmdOrCtrl+Shift+O"))?)
        .separator()
        .item(&item("save", "Salva", Some("CmdOrCtrl+S"))?)
        .item(&item("save_as", "Salva con nome...", Some("CmdOrCtrl+Shift+S"))?)
        .separator()
        .item(&item("quit", "Esci", Some("CmdOrCtrl+Q"))?)
        .build()?;

    let theme = SubmenuBuilder::new(app, "Tema")
        .item(&item("theme_auto", "Automatico", None)?)
        .item(&item("theme_github", "GitHub", None)?)
        .item(&item("theme_newsprint", "Newsprint", None)?)
        .item(&item("theme_night", "Night", None)?)
        .item(&item("theme_slate", "Slate", None)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "Vista")
        .item(&item("toggle_sidebar", "Barra laterale", Some("CmdOrCtrl+Shift+L"))?)
        .item(&item("source", "Modalità sorgente", Some("CmdOrCtrl+/"))?)
        .separator()
        .item(&theme)
        .build()?;

    let mut menu = MenuBuilder::new(app).item(&file);
    if cfg!(target_os = "macos") {
        let edit = SubmenuBuilder::new(app, "Modifica")
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;
        menu = menu.item(&edit);
    }
    menu.item(&view).build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.clone());
        })
        .invoke_handler(tauri::generate_handler![read_text_file, write_text_file, list_dir])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

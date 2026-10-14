use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

mod pdf;

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

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

const MAX_INLINE_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

fn image_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        _ => None,
    }
}

/// Legge un'immagine locale relativa (estensione ammessa, max 10 MB): (estensione, byte).
pub(crate) fn read_local_image(base_dir: &Path, url: &str) -> Option<(&'static str, Vec<u8>)> {
    if url.contains(':') || url.starts_with('/') || url.starts_with('\\') {
        return None;
    }
    let decoded = percent_encoding::percent_decode_str(url).decode_utf8().ok()?;
    let candidates: [PathBuf; 2] = [base_dir.join(url), base_dir.join(decoded.as_ref())];
    let path = candidates.into_iter().find(|p| p.is_file())?;
    let mime = image_mime(&path)?;
    if fs::metadata(&path).ok()?.len() > MAX_INLINE_IMAGE_BYTES {
        return None;
    }
    let extension = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "svg",
    };
    Some((extension, fs::read(&path).ok()?))
}

/// Converte un'immagine locale relativa in data URI; None se non applicabile.
fn inline_image(base_dir: &Path, url: &str) -> Option<String> {
    use base64::Engine;

    let (extension, bytes) = read_local_image(base_dir, url)?;
    let mime = match extension {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/svg+xml",
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

/// Valore di un attributo nel tag di apertura (`name="valore"`).
fn attr_value<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let marker = format!(" {name}=\"");
    let start = tag.find(&marker)? + marker.len();
    let end = tag[start..].find('"')?;
    Some(&tag[start..start + end])
}

fn remove_attr(tag: &str, name: &str) -> String {
    let marker = format!(" {name}=\"");
    match tag.find(&marker) {
        Some(start) => {
            let value_start = start + marker.len();
            match tag[value_start..].find('"') {
                Some(end) => format!("{}{}", &tag[..start], &tag[value_start + end + 1..]),
                None => tag.to_string(),
            }
        }
        None => tag.to_string(),
    }
}

/// Mermaid produce `width="100%"`: sostituisce larghezza e altezza con quelle del viewBox,
/// così il diagramma ha una dimensione propria sia in HTML (con CSS) sia in Typst.
pub(crate) fn normalize_svg(svg: &str) -> String {
    let Some(tag_end) = svg.find('>') else { return svg.to_string() };
    let (tag, rest) = svg.split_at(tag_end);
    let Some(view_box) = attr_value(tag, "viewBox") else { return svg.to_string() };
    let numbers: Vec<f64> = view_box
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse().ok())
        .collect();
    if numbers.len() != 4 || numbers[2] <= 0.0 || numbers[3] <= 0.0 {
        return svg.to_string();
    }
    let tag = remove_attr(&remove_attr(tag, "width"), "height");
    format!("{tag} width=\"{}\" height=\"{}\"{rest}", numbers[2], numbers[3])
}

/// Rifiuta SVG con script, URL javascript: o gestori di eventi (on...=).
pub(crate) fn svg_is_safe(svg: &str) -> bool {
    let lower = svg.to_ascii_lowercase();
    if lower.contains("<script") || lower.contains("javascript:") {
        return false;
    }
    let bytes = lower.as_bytes();
    let mut index = 0;
    while let Some(found) = lower[index..].find(" on") {
        let start = index + found + 3;
        let mut end = start;
        while end < bytes.len() && bytes[end].is_ascii_alphabetic() {
            end += 1;
        }
        if end > start && end < bytes.len() && bytes[end] == b'=' {
            return false;
        }
        index = start;
    }
    true
}

/// Larghezza e altezza (in ex) e spostamento verticale (in ex, negativo = sotto la linea di base)
/// dell'SVG prodotto da MathJax.
pub(crate) fn math_metrics(svg: &str) -> Option<(f64, f64, f64)> {
    let tag = &svg[..svg.find('>')?];
    let ex = |value: &str| value.trim().trim_end_matches("ex").trim().parse::<f64>().ok();
    let width = ex(attr_value(tag, "width")?)?;
    let height = ex(attr_value(tag, "height")?)?;
    let style = attr_value(tag, "style").unwrap_or("");
    let shift = style
        .split(';')
        .find_map(|rule| rule.trim().strip_prefix("vertical-align:").and_then(ex))
        .unwrap_or(0.0);
    (width > 0.0 && height > 0.0).then_some((width, height, shift))
}

/// Chiave di una formula nella mappa ricevuta dal frontend: "d:" blocco, "i:" inline, poi il LaTeX.
pub(crate) fn math_key(display: bool, literal: &str) -> String {
    format!("{}:{}", if display { "d" } else { "i" }, literal.trim())
}

#[derive(serde::Serialize)]
struct MathItem {
    display: bool,
    tex: String,
}

/// Formule del documento (uniche, in ordine), lette con lo stesso parser dell'export.
#[tauri::command]
fn list_math(markdown: String) -> Vec<MathItem> {
    use comrak::nodes::NodeValue;
    use comrak::{Arena, Options, parse_document};

    let mut options = Options::default();
    options.extension.math_dollars = true;
    let arena = Arena::new();
    let root = parse_document(&arena, &markdown, &options);
    let mut seen = std::collections::HashSet::new();
    let mut items = Vec::new();
    for node in root.descendants() {
        if let NodeValue::Math(math) = &node.data().value {
            let tex = math.literal.trim().to_string();
            if !tex.is_empty() && seen.insert(math_key(math.display_math, &tex)) {
                items.push(MathItem { display: math.display_math, tex });
            }
        }
    }
    items
}

pub(crate) fn is_mermaid(info: &str) -> bool {
    info.split_whitespace().next().is_some_and(|lang| lang.eq_ignore_ascii_case("mermaid"))
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Genera un documento HTML autonomo dal Markdown (HTML grezzo del sorgente escluso).
#[tauri::command]
fn render_html(
    markdown: String,
    base_dir: Option<String>,
    title: String,
    css: String,
    diagrams: Option<HashMap<String, String>>,
    formulas: Option<HashMap<String, String>>,
) -> Result<String, String> {
    use comrak::nodes::{Ast, AstNode, NodeValue};
    use comrak::{Arena, Options, format_html, parse_document};
    use std::cell::RefCell;

    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.footnotes = true;
    options.extension.math_dollars = true;

    let arena = Arena::new();
    let root = parse_document(&arena, &markdown, &options);

    if let Some(dir) = base_dir.as_deref().map(Path::new) {
        for node in root.descendants() {
            if let NodeValue::Image(link) = &mut node.data_mut().value {
                if let Some(data_uri) = inline_image(dir, &link.url) {
                    link.url = data_uri;
                }
            }
        }
    }

    // Blocchi mermaid: segnaposto nell'albero, SVG sostituito dopo il rendering.
    let diagrams = diagrams.unwrap_or_default();
    let mut figures: Vec<(String, String)> = Vec::new();
    let mermaid_nodes: Vec<_> = root
        .descendants()
        .filter(|node| matches!(&node.data().value, NodeValue::CodeBlock(code) if is_mermaid(&code.info)))
        .collect();
    for node in mermaid_nodes {
        let code = match &node.data().value {
            NodeValue::CodeBlock(code) => code.literal.trim().to_string(),
            _ => continue,
        };
        let Some(svg) = diagrams.get(&code).filter(|svg| svg_is_safe(svg)) else { continue };
        let token = format!("SNIBMERMAID{}END", figures.len());
        node.data_mut().value = NodeValue::Paragraph;
        let text = Ast::new(NodeValue::Text(token.clone().into()), (0, 0).into());
        node.append(arena.alloc(AstNode::new(RefCell::new(text))));
        figures.push((token, normalize_svg(svg)));
    }

    // Formule: testo segnaposto nell'albero, SVG di MathJax sostituito dopo il rendering.
    let formulas = formulas.unwrap_or_default();
    let mut equations: Vec<(String, String)> = Vec::new();
    let math_nodes: Vec<_> = root
        .descendants()
        .filter(|node| matches!(&node.data().value, NodeValue::Math(_)))
        .collect();
    for node in math_nodes {
        let (key, display) = match &node.data().value {
            NodeValue::Math(math) => (math_key(math.display_math, &math.literal), math.display_math),
            _ => continue,
        };
        let Some(svg) = formulas.get(&key).filter(|svg| svg_is_safe(svg)) else { continue };
        let token = format!("SNIBMATH{}END", equations.len());
        node.data_mut().value = NodeValue::Text(token.clone().into());
        let class = if display { "math math-display" } else { "math math-inline" };
        equations.push((token, format!("<span class=\"{class}\">{svg}</span>")));
    }

    let mut body = String::new();
    format_html(root, &options, &mut body).map_err(|e| e.to_string())?;
    for (token, html) in &equations {
        body = body.replace(token, html);
    }
    for (token, svg) in &figures {
        body = body.replace(
            &format!("<p>{token}</p>"),
            &format!("<figure class=\"diagram\">{svg}</figure>"),
        );
    }

    Ok(format!(
        "<!doctype html>\n<html lang=\"it\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{}</title>\n<style>\n{}\n</style>\n</head>\n\
         <body>\n<article class=\"markdown-body\">\n{}</article>\n</body>\n</html>\n",
        escape_html(&title),
        css,
        body
    ))
}

const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;

/// Nome file sicuro per un'immagine importata: stem ripulito, estensione ammessa.
fn sanitize_asset_name(name: &str) -> Option<String> {
    let path = Path::new(name);
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    image_mime(Path::new(&format!("x.{extension}")))?;
    let stem = path.file_stem()?.to_str()?;
    let mut clean = String::new();
    for c in stem.chars() {
        if c.is_alphanumeric() || c == '-' || c == '_' {
            clean.push(c);
        } else if !clean.ends_with('-') {
            clean.push('-');
        }
    }
    let clean: String = clean.trim_matches('-').chars().take(60).collect();
    let clean = if clean.is_empty() { "image".to_string() } else { clean };
    Some(format!("{clean}.{extension}"))
}

/// Salva i byte in `<doc_dir>/assets/`, senza sovrascrivere; restituisce il percorso relativo.
fn store_asset(doc_dir: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    use std::io::Write;

    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("immagine troppo grande (max 50 MB)".to_string());
    }
    let file_name = sanitize_asset_name(name).ok_or("formato immagine non supportato")?;
    let dir = doc_dir.join("assets");
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let (stem, extension) = file_name.rsplit_once('.').ok_or("nome file non valido")?;

    let mut candidate = file_name.clone();
    for attempt in 1..10_000 {
        match fs::OpenOptions::new().write(true).create_new(true).open(dir.join(&candidate)) {
            Ok(mut file) => {
                file.write_all(bytes).map_err(|e| format!("{candidate}: {e}"))?;
                return Ok(format!("assets/{candidate}"));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                candidate = format!("{stem}-{attempt}.{extension}");
            }
            Err(e) => return Err(format!("{candidate}: {e}")),
        }
    }
    Err("troppi file omonimi in assets/".to_string())
}

/// Legge un'immagine locale per la visualizzazione nell'editor (byte grezzi).
#[tauri::command]
fn read_image_file(path: String) -> Result<tauri::ipc::Response, String> {
    let file = Path::new(&path);
    image_mime(file).ok_or("formato immagine non supportato")?;
    let size = fs::metadata(file).map_err(|e| format!("{path}: {e}"))?.len();
    if size > MAX_IMAGE_BYTES {
        return Err("immagine troppo grande (max 50 MB)".to_string());
    }
    let bytes = fs::read(file).map_err(|e| format!("{path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Salva un'immagine incollata o trascinata (corpo grezzo) in `assets/` accanto al documento.
/// Intestazioni: `x-doc-dir` e `x-file-name`, codificate con encodeURIComponent.
#[tauri::command]
fn save_asset(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("corpo della richiesta non valido".to_string());
    };
    let header = |name: &str| -> Result<String, String> {
        let value = request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| format!("intestazione mancante: {name}"))?;
        percent_encoding::percent_decode_str(value)
            .decode_utf8()
            .map(|v| v.into_owned())
            .map_err(|e| e.to_string())
    };
    let dir = header("x-doc-dir")?;
    let name = header("x-file-name")?;
    store_asset(Path::new(&dir), &name, bytes)
}

/// Importa un file immagine scelto dall'utente: percorso relativo se già nella cartella del documento, altrimenti copia in `assets/`.
#[tauri::command]
fn import_asset(src: String, doc_dir: String) -> Result<String, String> {
    let src_path = Path::new(&src);
    image_mime(src_path).ok_or("formato immagine non supportato")?;
    let size = fs::metadata(src_path).map_err(|e| format!("{src}: {e}"))?.len();
    if size > MAX_IMAGE_BYTES {
        return Err("immagine troppo grande (max 50 MB)".to_string());
    }
    if let (Ok(real_src), Ok(real_dir)) = (fs::canonicalize(src_path), fs::canonicalize(&doc_dir)) {
        if let Ok(relative) = real_src.strip_prefix(&real_dir) {
            let parts: Vec<_> = relative.components().map(|c| c.as_os_str().to_string_lossy()).collect();
            return Ok(parts.join("/"));
        }
    }
    let bytes = fs::read(src_path).map_err(|e| format!("{src}: {e}"))?;
    let name = src_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    store_asset(Path::new(&doc_dir), &name, &bytes)
}

/// Impostazioni PDF globali, salvate in `<config dir dell'app>/pdf-settings.json`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfSettings {
    paper: String,
    margin_mm: f32,
    header: Vec<String>,
    footer: Vec<String>,
}

impl Default for PdfSettings {
    fn default() -> Self {
        Self {
            paper: "a4".to_string(),
            margin_mm: 22.0,
            header: vec![String::new(), String::new(), "{title}".to_string()],
            footer: vec![String::new(), "{page} / {pages}".to_string(), String::new()],
        }
    }
}

impl PdfSettings {
    /// Normalizza i valori: carta nota, margine 5-60 mm, tre campi per fascia, max 200 caratteri.
    fn sanitized(mut self) -> Self {
        if !self.paper.eq_ignore_ascii_case("letter") {
            self.paper = "a4".to_string();
        } else {
            self.paper = "letter".to_string();
        }
        self.margin_mm = if self.margin_mm.is_finite() {
            self.margin_mm.clamp(5.0, 60.0)
        } else {
            22.0
        };
        for band in [&mut self.header, &mut self.footer] {
            band.resize(3, String::new());
            for field in band.iter_mut() {
                *field = field.chars().filter(|c| !c.is_control()).take(200).collect();
            }
        }
        self
    }
}

fn pdf_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("pdf-settings.json"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_pdf_settings(app: AppHandle) -> Result<PdfSettings, String> {
    let path = pdf_settings_path(&app)?;
    Ok(fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<PdfSettings>(&text).ok())
        .map(PdfSettings::sanitized)
        .unwrap_or_default())
}

#[tauri::command]
fn save_pdf_settings(app: AppHandle, settings: PdfSettings) -> Result<PdfSettings, String> {
    let settings = settings.sanitized();
    let path = pdf_settings_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(settings)
}

/// Genera il PDF con Typst e lo scrive su `path`.
#[tauri::command]
async fn export_pdf(
    path: String,
    markdown: String,
    options: pdf::PdfExportOptions,
) -> Result<(), String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || pdf::build(&markdown, &options))
        .await
        .map_err(|e| e.to_string())??;
    fs::write(&path, bytes).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
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
        .item(&item("export_html", "Esporta come HTML...", None)?)
        .item(&item("export_pdf", "Esporta come PDF...", Some("CmdOrCtrl+Shift+E"))?)
        .item(&item("pdf_settings", "Impostazioni PDF predefinite...", None)?)
        .item(&item("print", "Stampa...", Some("CmdOrCtrl+P"))?)
        .separator()
        .item(&item("quit", "Esci", Some("CmdOrCtrl+Q"))?)
        .build()?;

    let insert = SubmenuBuilder::new(app, "Inserisci")
        .item(&item("insert_image", "Immagine...", Some("CmdOrCtrl+Shift+I"))?)
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
    menu.item(&insert).item(&view).build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.clone());
        })
        .invoke_handler(tauri::generate_handler![read_text_file, write_text_file, list_dir, render_html, list_math, export_pdf, print_page, load_pdf_settings, save_pdf_settings, read_image_file, save_asset, import_asset])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(markdown: &str, base_dir: Option<String>) -> String {
        render_html(markdown.to_string(), base_dir, "T & <t>".to_string(), "body{}".to_string(), None, None).unwrap()
    }

    #[test]
    fn asset_names_are_sanitized_and_deduplicated() {
        assert_eq!(sanitize_asset_name("Foto Mare (1).JPG").as_deref(), Some("Foto-Mare-1.jpg"));
        assert_eq!(sanitize_asset_name("../../etc/passwd"), None);
        assert_eq!(sanitize_asset_name("a.exe"), None);
        assert_eq!(sanitize_asset_name("###.png").as_deref(), Some("image.png"));

        let dir = std::env::temp_dir().join(format!("s-nib-assets-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(store_asset(&dir, "x.png", &[1]).unwrap(), "assets/x.png");
        assert_eq!(store_asset(&dir, "x.png", &[2]).unwrap(), "assets/x-1.png");
        assert_eq!(fs::read(dir.join("assets/x.png")).unwrap(), vec![1]);
        assert!(store_asset(&dir, "x.txt", &[1]).is_err());
        fs::write(dir.join("inside.png"), [9]).unwrap();
        assert_eq!(import_asset(dir.join("inside.png").to_string_lossy().into_owned(), dir.to_string_lossy().into_owned()).unwrap(), "inside.png");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn normalizes_and_checks_svg() {
        let flow = include_str!("../tests/fixtures/mermaid-flow.svg");
        assert!(svg_is_safe(flow));
        let normalized = normalize_svg(flow);
        assert!(normalized.contains(" width=\"360\" height=\"487\""));
        assert!(!normalized.contains("width=\"100%\""));
        assert!(!svg_is_safe("<svg><script>x</script></svg>"));
        assert!(!svg_is_safe("<svg onload=\"x()\"></svg>"));
        assert!(!svg_is_safe("<svg><a href=\"javascript:x\"/></svg>"));
        assert!(svg_is_safe("<svg><text>one two online</text></svg>"));
        assert!(is_mermaid("Mermaid title") && !is_mermaid("rust"));
    }

    #[test]
    fn replaces_mermaid_blocks_with_figures() {
        let flow = include_str!("../tests/fixtures/mermaid-flow.svg");
        let code = "flowchart TD\n A --> B";
        let mut map = HashMap::new();
        map.insert(code.to_string(), flow.to_string());
        map.insert("bad".to_string(), "<svg><script>x</script></svg>".to_string());

        let markdown = format!("```mermaid\n{code}\n```\n\n```mermaid\nbad\n```\n\n```mermaid\nunknown\n```\n");
        let html = render_html(markdown, None, "t".into(), "".into(), Some(map), None).unwrap();
        assert!(html.contains("<figure class=\"diagram\"><svg"));
        assert!(!html.contains("SNIBMERMAID"));
        // SVG pericoloso o sconosciuto: resta il blocco di codice
        assert!(html.contains("language-mermaid"));
        assert_eq!(html.matches("<figure").count(), 1);
    }

    #[test]
    fn lists_math_and_ignores_currency() {
        let items = list_math("Costa $5 e $10 euro, formula $x^2$ e\n\n$$\n\\frac{a}{b}\n$$\n".to_string());
        let keys: Vec<String> = items.iter().map(|i| math_key(i.display, &i.tex)).collect();
        assert_eq!(keys, vec!["i:x^2".to_string(), "d:\\frac{a}{b}".to_string()]);
    }

    #[test]
    fn reads_mathjax_metrics() {
        let inline = include_str!("../tests/fixtures/math-inline.svg");
        let (w, h, shift) = math_metrics(inline).unwrap();
        assert!((w - 6.889).abs() < 1e-6 && (h - 2.685).abs() < 1e-6 && (shift + 0.798).abs() < 1e-6);
        assert!(math_metrics("<svg></svg>").is_none());
    }

    #[test]
    fn replaces_math_with_svg_in_html() {
        let mut formulas = HashMap::new();
        formulas.insert("i:x^2 + \\frac{a}{b}".to_string(), include_str!("../tests/fixtures/math-inline.svg").to_string());
        formulas.insert("d:y".to_string(), "<svg onload=\"x()\"></svg>".to_string());
        let html = render_html(
            "Formula $x^2 + \\frac{a}{b}$ qui.\n\n$$y$$\n".to_string(),
            None, "t".into(), "".into(), None, Some(formulas),
        ).unwrap();
        assert!(html.contains("<span class=\"math math-inline\"><svg"));
        assert!(!html.contains("SNIBMATH"));
        // SVG non sicuro: la formula resta come testo
        assert!(!html.contains("onload"));
        assert!(html.contains("data-math-style"));
    }

    #[test]
    fn pdf_settings_are_sanitized() {
        let settings = PdfSettings {
            paper: "tabloid".to_string(),
            margin_mm: f32::NAN,
            header: vec!["a\nb".to_string()],
            footer: vec!["x".repeat(500); 5],
        }
        .sanitized();
        assert_eq!(settings.paper, "a4");
        assert_eq!(settings.margin_mm, 22.0);
        assert_eq!(settings.header, vec!["ab".to_string(), String::new(), String::new()]);
        assert_eq!(settings.footer.len(), 3);
        assert!(settings.footer.iter().all(|f| f.chars().count() == 200));
        assert_eq!(PdfSettings { margin_mm: 500.0, ..PdfSettings::default() }.sanitized().margin_mm, 60.0);
    }

    #[test]
    fn renders_gfm_and_escapes_raw_html() {
        let html = render("# Hi\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n~~old~~\n\n<script>alert(1)</script>", None);
        assert!(html.contains("<h1>"));
        assert!(html.contains("<table>"));
        assert!(html.contains("type=\"checkbox\""));
        assert!(html.contains("<del>old</del>"));
        assert!(!html.contains("<script>alert"));
        assert!(html.contains("<title>T &amp; &lt;t&gt;</title>"));
    }

    #[test]
    fn inlines_only_local_images_with_known_extension() {
        let dir = std::env::temp_dir().join(format!("s-nib-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a b.png"), [137, 80, 78, 71]).unwrap();
        fs::write(dir.join("secret.txt"), "x").unwrap();
        let base = Some(dir.to_string_lossy().into_owned());

        let html = render("![x](a%20b.png)\n\n![y](secret.txt)\n\n![z](https://example.com/i.png)", base);
        assert!(html.contains("src=\"data:image/png;base64,"));
        assert!(html.contains("src=\"secret.txt\""));
        assert!(html.contains("src=\"https://example.com/i.png\""));

        fs::remove_dir_all(&dir).unwrap();
    }
}

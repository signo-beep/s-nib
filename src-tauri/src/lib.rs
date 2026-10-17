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

#[derive(serde::Serialize)]
struct SearchHit {
    path: String,
    name: String,
    line: usize,
    text: String,
}

#[derive(serde::Serialize)]
struct SearchResult {
    hits: Vec<SearchHit>,
    truncated: bool,
}

const SEARCH_MAX_HITS: usize = 500;
const SEARCH_MAX_FILES: usize = 20_000;
const SEARCH_MAX_DEPTH: usize = 16;
const SEARCH_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Text search in the Markdown files of a folder (recursive, hidden entries and symlinks skipped).
fn search_folder_sync(root: &Path, query: &str, case_sensitive: bool) -> SearchResult {
    let needle = if case_sensitive { query.to_string() } else { query.to_lowercase() };
    let mut hits = Vec::new();
    let mut truncated = false;
    let mut visited = 0usize;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    'walk: while let Some((dir, depth)) = stack.pop() {
        let Ok(read) = fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = read.flatten().collect();
        entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
        let mut subdirs = Vec::new();
        for entry in entries {
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                if depth < SEARCH_MAX_DEPTH {
                    subdirs.push((path, depth + 1));
                }
                continue;
            }
            if !kind.is_file() || !is_markdown(&path) {
                continue;
            }
            visited += 1;
            if visited > SEARCH_MAX_FILES {
                truncated = true;
                break 'walk;
            }
            if entry.metadata().map(|m| m.len() > SEARCH_MAX_FILE_BYTES).unwrap_or(true) {
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else { continue };
            for (index, line) in content.lines().enumerate() {
                let found = if case_sensitive { line.contains(&needle) } else { line.to_lowercase().contains(&needle) };
                if !found {
                    continue;
                }
                if hits.len() >= SEARCH_MAX_HITS {
                    truncated = true;
                    break 'walk;
                }
                hits.push(SearchHit {
                    path: path.to_string_lossy().into_owned(),
                    name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    line: index + 1,
                    text: line.trim().chars().take(200).collect(),
                });
            }
        }
        // reversed so that the folders are visited in alphabetical order
        stack.extend(subdirs.into_iter().rev());
    }
    SearchResult { hits, truncated }
}

#[tauri::command]
async fn search_folder(root: String, query: String, case_sensitive: bool) -> Result<SearchResult, String> {
    if query.is_empty() || query.chars().count() > 200 {
        return Err("Invalid search text".to_string());
    }
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err(format!("{}: not a folder", root.display()));
    }
    tauri::async_runtime::spawn_blocking(move || search_folder_sync(&root, &query, case_sensitive))
        .await
        .map_err(|e| e.to_string())
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

/// Reads a relative local image (allowed extension, max 10 MB): (extension, bytes).
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

/// Converts a relative local image to a data URI; None if not applicable.
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

/// Value of an attribute in the opening tag (`name="value"`).
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

/// Mermaid emits `width="100%"`: replaces width and height with the viewBox ones,
/// so the diagram has its own size in both HTML (with CSS) and Typst.
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

/// Rejects SVG with scripts, javascript: URLs or event handlers (on...=).
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

/// Width and height (in ex) and vertical shift (in ex, negative = below the baseline)
/// of the SVG produced by MathJax.
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

/// Key of a formula in the map received from the frontend: "d:" block, "i:" inline, then the LaTeX.
pub(crate) fn math_key(display: bool, literal: &str) -> String {
    format!("{}:{}", if display { "d" } else { "i" }, literal.trim())
}

#[derive(serde::Serialize)]
struct MathItem {
    display: bool,
    tex: String,
}

/// Document formulas (unique, in order), read with the same parser as the export.
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

#[derive(serde::Serialize)]
struct CodeItem {
    lang: String,
    code: String,
}

/// First word of a fence info string, lowercased and limited to safe characters.
fn code_lang(info: &str) -> String {
    info.split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '#' | '.'))
        .collect()
}

pub(crate) fn code_key(lang: &str, literal: &str) -> String {
    format!("{lang}\u{0}{literal}")
}

/// Fenced code blocks to highlight (unique, in order, Mermaid excluded), read with the same parser as the export.
#[tauri::command]
fn list_code(markdown: String) -> Vec<CodeItem> {
    use comrak::nodes::NodeValue;
    use comrak::{Arena, Options, parse_document};

    let arena = Arena::new();
    let root = parse_document(&arena, &markdown, &Options::default());
    let mut seen = std::collections::HashSet::new();
    let mut items = Vec::new();
    for node in root.descendants() {
        if let NodeValue::CodeBlock(code) = &node.data().value {
            let lang = code_lang(&code.info);
            if lang.is_empty() || is_mermaid(&code.info) {
                continue;
            }
            if seen.insert(code_key(&lang, &code.literal)) {
                items.push(CodeItem { lang, code: code.literal.to_string() });
            }
        }
    }
    items
}

/// Highlighted code is accepted only if it holds nothing but text and `<span class="hl-...">` tags.
fn highlight_is_safe(html: &str) -> bool {
    let mut rest = html;
    while let Some(index) = rest.find('<') {
        rest = &rest[index..];
        if let Some(after) = rest.strip_prefix("</span>") {
            rest = after;
            continue;
        }
        let Some(after) = rest.strip_prefix("<span class=\"hl-") else { return false };
        let Some(end) = after.find("\">") else { return false };
        if !after[..end].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return false;
        }
        rest = &after[end + 2..];
    }
    true
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

/// Generates a self-contained HTML document from Markdown (raw HTML in the source is dropped).
#[tauri::command]
fn render_html(
    markdown: String,
    base_dir: Option<String>,
    title: String,
    css: String,
    diagrams: Option<HashMap<String, String>>,
    formulas: Option<HashMap<String, String>>,
    highlights: Option<HashMap<String, String>>,
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
    options.extension.alerts = true;

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

    // Mermaid blocks: placeholder in the tree, SVG substituted after rendering.
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

    // Formulas: placeholder text in the tree, MathJax SVG substituted after rendering.
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

    // Scaled images (Milkdown image-block: the alt text holds the ratio, "0.55"): placeholder, then <img> with max-width.
    let mut scaled: Vec<(String, String)> = Vec::new();
    let image_nodes: Vec<_> = root
        .descendants()
        .filter(|node| matches!(&node.data().value, NodeValue::Image(_)))
        .collect();
    for node in image_nodes {
        let alt: String = node
            .descendants()
            .skip(1)
            .filter_map(|child| match &child.data().value {
                NodeValue::Text(text) => Some(text.to_string()),
                _ => None,
            })
            .collect();
        let ratio = alt
            .trim()
            .parse::<f32>()
            .ok()
            .filter(|ratio| alt.contains('.') && (0.1..=4.0).contains(ratio));
        let Some(ratio) = ratio else { continue };
        let (url, title) = match &node.data().value {
            NodeValue::Image(link) => (link.url.to_string(), link.title.to_string()),
            _ => continue,
        };
        let children: Vec<_> = node.children().collect();
        for child in children {
            child.detach();
        }
        let token = format!("SNIBIMAGE{}END", scaled.len());
        node.data_mut().value = NodeValue::Text(token.clone().into());
        let title_attr = if title.is_empty() { String::new() } else { format!(" title=\"{}\"", escape_html(&title)) };
        let width = (ratio * 100.0).round().min(100.0);
        scaled.push((
            token,
            format!("<img src=\"{}\" alt=\"\"{title_attr} style=\"max-width: {width}%;\">", escape_html(&url)),
        ));
    }

    // Highlighted code blocks: placeholder in the tree, markup from the frontend substituted after rendering.
    let highlights = highlights.unwrap_or_default();
    let mut blocks: Vec<(String, String)> = Vec::new();
    let code_nodes: Vec<_> = root
        .descendants()
        .filter(|node| matches!(&node.data().value, NodeValue::CodeBlock(_)))
        .collect();
    for node in code_nodes {
        let (lang, key) = match &node.data().value {
            NodeValue::CodeBlock(code) if !is_mermaid(&code.info) => {
                let lang = code_lang(&code.info);
                let key = code_key(&lang, &code.literal);
                (lang, key)
            }
            _ => continue,
        };
        let Some(markup) = highlights.get(&key).filter(|markup| highlight_is_safe(markup)) else { continue };
        let token = format!("SNIBCODE{}END", blocks.len());
        node.data_mut().value = NodeValue::Paragraph;
        let text = Ast::new(NodeValue::Text(token.clone().into()), (0, 0).into());
        node.append(arena.alloc(AstNode::new(RefCell::new(text))));
        blocks.push((token, format!("<pre><code class=\"language-{lang}\">{markup}</code></pre>")));
    }

    let mut body = String::new();
    format_html(root, &options, &mut body).map_err(|e| e.to_string())?;
    for (token, html) in &equations {
        body = body.replace(token, html);
    }
    for (token, html) in &scaled {
        body = body.replace(token, html);
    }
    for (token, html) in &blocks {
        body = body.replace(&format!("<p>{token}</p>"), html);
    }
    for (token, svg) in &figures {
        body = body.replace(
            &format!("<p>{token}</p>"),
            &format!("<figure class=\"diagram\">{svg}</figure>"),
        );
    }

    Ok(format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{}</title>\n<style>\n{}\n</style>\n</head>\n\
         <body>\n<article class=\"markdown-body\">\n{}</article>\n</body>\n</html>\n",
        escape_html(&title),
        css,
        body
    ))
}

const MAX_IMAGE_BYTES: u64 = 50 * 1024 * 1024;

/// Safe file name for an imported image: cleaned stem, allowed extension.
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

/// Saves the bytes in `<doc_dir>/assets/` without overwriting; returns the relative path.
fn store_asset(doc_dir: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    use std::io::Write;

    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("image too large (max 50 MB)".to_string());
    }
    let file_name = sanitize_asset_name(name).ok_or("unsupported image format")?;
    let dir = doc_dir.join("assets");
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let (stem, extension) = file_name.rsplit_once('.').ok_or("invalid file name")?;

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
    Err("too many files with the same name in assets/".to_string())
}

/// First command line argument that is an existing Markdown or text file (file manager "Open with").
#[tauri::command]
fn initial_file() -> Option<String> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|path| path.is_file() && is_markdown(path))
        .and_then(|path| std::path::absolute(path).ok())
        .map(|path| path.to_string_lossy().into_owned())
}

/// Reads a local image for display in the editor (raw bytes).
#[tauri::command]
fn read_image_file(path: String) -> Result<tauri::ipc::Response, String> {
    let file = Path::new(&path);
    image_mime(file).ok_or("unsupported image format")?;
    let size = fs::metadata(file).map_err(|e| format!("{path}: {e}"))?.len();
    if size > MAX_IMAGE_BYTES {
        return Err("image too large (max 50 MB)".to_string());
    }
    let bytes = fs::read(file).map_err(|e| format!("{path}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Saves a pasted or dropped image (raw body) in `assets/` next to the document.
/// Headers: `x-doc-dir` and `x-file-name`, encoded with encodeURIComponent.
#[tauri::command]
fn save_asset(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("invalid request body".to_string());
    };
    let header = |name: &str| -> Result<String, String> {
        let value = request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| format!("missing header: {name}"))?;
        percent_encoding::percent_decode_str(value)
            .decode_utf8()
            .map(|v| v.into_owned())
            .map_err(|e| e.to_string())
    };
    let dir = header("x-doc-dir")?;
    let name = header("x-file-name")?;
    store_asset(Path::new(&dir), &name, bytes)
}

/// Imports an image file picked by the user: relative path if already inside the document folder, otherwise copies it into `assets/`.
#[tauri::command]
fn import_asset(src: String, doc_dir: String) -> Result<String, String> {
    let src_path = Path::new(&src);
    image_mime(src_path).ok_or("unsupported image format")?;
    let size = fs::metadata(src_path).map_err(|e| format!("{src}: {e}"))?.len();
    if size > MAX_IMAGE_BYTES {
        return Err("image too large (max 50 MB)".to_string());
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

/// Global PDF settings, saved in `<app config dir>/pdf-settings.json`.
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
    /// Normalizes the values: known paper, margin 5-60 mm, three fields per band, max 200 characters.
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

/// Generates the PDF with Typst and writes it to `path`.
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

/// Converts the Markdown with pandoc (`docx` or `odt`) and writes the result to `path`.
/// Relative image paths resolve against `base_dir`.
#[tauri::command]
async fn export_pandoc(
    path: String,
    markdown: String,
    format: String,
    base_dir: Option<String>,
) -> Result<(), String> {
    if format != "docx" && format != "odt" {
        return Err(format!("unsupported format: {format}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let mut command = Command::new("pandoc");
        command
            .args(["-f", "gfm+tex_math_dollars", "-t", &format, "-o", &path])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if let Some(dir) = base_dir {
            command.arg("--resource-path").arg(dir);
        }
        let mut child = command.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                let hint = if cfg!(target_os = "windows") {
                    "winget install JohnMacFarlane.Pandoc"
                } else if cfg!(target_os = "macos") {
                    "brew install pandoc"
                } else {
                    "sudo apt install pandoc"
                };
                format!("pandoc not found. Install it ({hint}) and try again.")
            } else {
                format!("pandoc: {e}")
            }
        })?;
        child
            .stdin
            .take()
            .ok_or("pandoc: no stdin")?
            .write_all(markdown.as_bytes())
            .map_err(|e| format!("pandoc: {e}"))?;
        let output = child.wait_with_output().map_err(|e| format!("pandoc: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!("pandoc: {}", String::from_utf8_lossy(&output.stderr).trim()))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// Modification time in ms since the epoch; `None` if the file does not exist.
#[tauri::command]
fn file_mtime(path: String) -> Result<Option<u64>, String> {
    match fs::metadata(&path) {
        Ok(meta) => {
            let modified = meta.modified().map_err(|e| format!("{path}: {e}"))?;
            let ms = modified
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64);
            Ok(Some(ms))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{path}: {e}")),
    }
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| format!("{path}: {e}"))
}

fn session_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("session.json"))
        .map_err(|e| e.to_string())
}

/// Recovery snapshot of the unsaved tabs, written atomically.
#[tauri::command]
fn save_session(app: AppHandle, json: String) -> Result<(), String> {
    let path = session_path(&app)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))
}

#[tauri::command]
fn load_session(app: AppHandle) -> Result<Option<String>, String> {
    Ok(fs::read_to_string(session_path(&app)?).ok())
}

#[tauri::command]
fn clear_session(app: AppHandle) -> Result<(), String> {
    match fs::remove_file(session_path(&app)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Turns the webview spell checker on or off. On Linux the languages are the
/// enchant/hunspell dictionary names (`en_US`, `it_IT`); Windows and macOS use
/// the system languages.
#[tauri::command]
fn set_spellcheck(window: tauri::WebviewWindow, languages: Vec<String>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    window
        .with_webview(move |webview| {
            use webkit2gtk::{WebContextExt, WebViewExt};
            if let Some(context) = webview.inner().context() {
                let names: Vec<&str> = languages.iter().map(String::as_str).collect();
                context.set_spell_checking_enabled(!names.is_empty());
                context.set_spell_checking_languages(&names);
            }
        })
        .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "linux"))]
    let _ = (window, languages);
    Ok(())
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
        .item(&item("new", "New", Some("CmdOrCtrl+N"))?)
        .item(&item("open", "Open...", Some("CmdOrCtrl+O"))?)
        .item(&item("open_folder", "Open folder...", Some("CmdOrCtrl+Shift+O"))?)
        .item(&item("search_folder", "Search in folder", Some("CmdOrCtrl+Shift+F"))?)
        .separator()
        .item(&item("save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item("save_as", "Save as...", Some("CmdOrCtrl+Shift+S"))?)
        .item(&item("autosave", "Autosave", None)?)
        .separator()
        .item(&item("close_pane", "Close pane", Some("CmdOrCtrl+W"))?)
        .separator()
        .item(&item("print", "Print...", Some("CmdOrCtrl+P"))?)
        .separator()
        .item(&item("quit", "Quit", Some("CmdOrCtrl+Q"))?)
        .build()?;

    let export = SubmenuBuilder::new(app, "Export")
        .item(&item("export_html", "HTML...", None)?)
        .item(&item("export_pdf", "PDF...", Some("CmdOrCtrl+Shift+E"))?)
        .item(&item("export_docx", "Word (DOCX)...", None)?)
        .item(&item("export_odt", "OpenDocument (ODT)...", None)?)
        .separator()
        .item(&item("pdf_settings", "Default PDF settings...", None)?)
        .build()?;

    let insert = SubmenuBuilder::new(app, "Insert")
        .item(&item("insert_image", "Image...", Some("CmdOrCtrl+Shift+I"))?)
        .item(&item("insert_table", "Table...", None)?)
        .item(&item("insert_front_matter", "Front matter (YAML)", Some("CmdOrCtrl+Shift+Y"))?)
        .build()?;

    let theme = SubmenuBuilder::new(app, "Theme")
        .item(&item("theme_auto", "Automatic", None)?)
        .item(&item("theme_github", "GitHub", None)?)
        .item(&item("theme_newsprint", "Newsprint", None)?)
        .item(&item("theme_night", "Night", None)?)
        .item(&item("theme_slate", "Slate", None)?)
        .build()?;

    let spellcheck = SubmenuBuilder::new(app, "Spellcheck")
        .item(&item("spell_off", "Off", None)?)
        .item(&item("spell_en", "English", None)?)
        .item(&item("spell_it", "Italian", None)?)
        .item(&item("spell_both", "English and Italian", None)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item("toggle_sidebar", "Sidebar", Some("CmdOrCtrl+Shift+L"))?)
        .item(&item("source", "Source mode", Some("CmdOrCtrl+/"))?)
        .item(&item("toggle_split", "Split view", Some("CmdOrCtrl+Backslash"))?)
        .item(&item("switch_pane", "Switch pane", Some("F6"))?)
        .item(&item("swap_panes", "Swap panes", Some("CmdOrCtrl+Shift+Backslash"))?)
        .separator()
        .item(&theme)
        .item(&spellcheck)
        .build()?;

    let mut menu = MenuBuilder::new(app).item(&file);
    if cfg!(target_os = "macos") {
        let edit = SubmenuBuilder::new(app, "Edit")
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;
        menu = menu.item(&edit);
    }
    let help = SubmenuBuilder::new(app, "Help")
        .item(&item("about", "About s-nib", None)?)
        .build()?;

    menu.item(&insert).item(&export).item(&view).item(&help).build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.clone());
        })
        .invoke_handler(tauri::generate_handler![read_text_file, write_text_file, file_mtime, list_dir, search_folder, initial_file, render_html, list_math, list_code, export_pdf, export_pandoc, print_page, load_pdf_settings, save_pdf_settings, read_image_file, save_asset, import_asset, save_session, load_session, clear_session, set_spellcheck])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(markdown: &str, base_dir: Option<String>) -> String {
        render_html(markdown.to_string(), base_dir, "T & <t>".to_string(), "body{}".to_string(), None, None, None).unwrap()
    }

    #[test]
    fn asset_names_are_sanitized_and_deduplicated() {
        assert_eq!(sanitize_asset_name("Sea Photo (1).JPG").as_deref(), Some("Sea-Photo-1.jpg"));
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
        let html = render_html(markdown, None, "t".into(), "".into(), Some(map), None, None).unwrap();
        assert!(html.contains("<figure class=\"diagram\"><svg"));
        assert!(!html.contains("SNIBMERMAID"));
        // dangerous or unknown SVG: the code block stays
        assert!(html.contains("language-mermaid"));
        assert_eq!(html.matches("<figure").count(), 1);
    }

    #[test]
    fn lists_math_and_ignores_currency() {
        let items = list_math("Costs $5 and $10 euro, formula $x^2$ and\n\n$$\n\\frac{a}{b}\n$$\n".to_string());
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
            "Formula $x^2 + \\frac{a}{b}$ here.\n\n$$y$$\n".to_string(),
            None, "t".into(), "".into(), None, Some(formulas), None,
        ).unwrap();
        assert!(html.contains("<span class=\"math math-inline\"><svg"));
        assert!(!html.contains("SNIBMATH"));
        // unsafe SVG: the formula stays as text
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
    fn renders_gfm_alerts() {
        let html = render("> [!WARNING]\n> Careful.\n\n> plain quote\n\n> [!NOTE]\n>\n> Spaced body", None);
        assert!(html.contains("markdown-alert-note"));
        assert!(html.contains("markdown-alert-warning"));
        assert!(html.contains("markdown-alert-title"));
        assert!(html.contains("<blockquote>"));
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

    #[test]
    fn highlights_code_blocks_and_rejects_unsafe_markup() {
        let literal = "let x = 1;\n";
        let mut map = HashMap::new();
        map.insert(code_key("rust", literal), "<span class=\"hl-keyword\">let</span> x = 1;\n".to_string());
        map.insert(code_key("js", "bad\n"), "<script>x</script>".to_string());
        let html = render_html(
            format!("```rust\n{literal}```\n\n```js\nbad\n```\n"),
            None, "t".into(), "".into(), None, None, Some(map),
        ).unwrap();
        assert!(html.contains("<pre><code class=\"language-rust\"><span class=\"hl-keyword\">let</span> x = 1;\n</code></pre>"));
        assert!(!html.contains("SNIBCODE") && !html.contains("<script>"));
        assert!(html.contains("language-js"));
        assert!(highlight_is_safe("a &lt; b <span class=\"hl-fn\">f</span>"));
        assert!(!highlight_is_safe("<span class=\"x\">") && !highlight_is_safe("<span class=\"hl-a\" onclick=\"x\">"));
    }

    #[test]
    fn lists_code_blocks_without_mermaid() {
        let items = list_code("```Rust\nfn a() {}\n```\n\n```mermaid\nA-->B\n```\n\n```\nplain\n```\n".to_string());
        assert_eq!(items.len(), 1);
        assert_eq!((items[0].lang.as_str(), items[0].code.as_str()), ("rust", "fn a() {}\n"));
    }

    #[test]
    fn applies_image_scale_in_html() {
        let html = render("![0.40](a.png \"Cap\")\n\n![x](b.png)", None);
        assert!(html.contains("<img src=\"a.png\" alt=\"\" title=\"Cap\" style=\"max-width: 40%;\">"));
        assert!(html.contains("alt=\"x\""));
        assert!(!html.contains("SNIBIMAGE"));
    }

    #[test]
    fn searches_markdown_files_in_folder() {
        let dir = std::env::temp_dir().join(format!("s-nib-search-{}", std::process::id()));
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::create_dir_all(dir.join(".hidden")).unwrap();
        fs::write(dir.join("a.md"), "one\nHello World\n").unwrap();
        fs::write(dir.join("sub/b.md"), "hello again\n").unwrap();
        fs::write(dir.join("c.png"), "hello").unwrap();
        fs::write(dir.join(".hidden/d.md"), "hello").unwrap();
        let found = search_folder_sync(&dir, "hello", false);
        let names: Vec<(String, usize)> = found.hits.iter().map(|h| (h.name.clone(), h.line)).collect();
        assert_eq!(names, vec![("a.md".to_string(), 2), ("b.md".to_string(), 1)]);
        assert_eq!(search_folder_sync(&dir, "hello", true).hits.len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }
}

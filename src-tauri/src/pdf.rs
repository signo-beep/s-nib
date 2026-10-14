//! Export PDF: Markdown (comrak) -> sorgente Typst -> PDF, tutto in processo.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use comrak::nodes::{AstNode, ListType, NodeValue, TableAlignment};
use comrak::{Arena, Options, parse_document};
use serde::Deserialize;
use typst::diag::{FileError, FileResult, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime, Duration};
use typst_layout::PagedDocument;
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};

const OPEN_SANS: [&[u8]; 4] = [
    include_bytes!("../fonts/OpenSans-Regular.ttf"),
    include_bytes!("../fonts/OpenSans-Italic.ttf"),
    include_bytes!("../fonts/OpenSans-Bold.ttf"),
    include_bytes!("../fonts/OpenSans-BoldItalic.ttf"),
];

/// Opzioni di export ricevute dal frontend.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfExportOptions {
    /// "a4" oppure "letter".
    pub paper: String,
    /// Margine in millimetri.
    pub margin_mm: f32,
    /// Sinistra, centro, destra. Segnaposto: {title} {date} {page} {pages}.
    pub header: Vec<String>,
    pub footer: Vec<String>,
    pub title: String,
    pub date: String,
    pub base_dir: Option<String>,
    /// Diagrammi Mermaid già resi in SVG, indicizzati dal codice sorgente (senza spazi ai bordi).
    #[serde(default)]
    pub diagrams: HashMap<String, String>,
}

// ---------------------------------------------------------------------------
// Conversione Markdown -> Typst
// ---------------------------------------------------------------------------

/// Escape per testo in modalità markup: ogni carattere sensibile diventa letterale.
fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '\\' | '#' | '$' | '*' | '_' | '`' | '<' | '>' | '@' | '[' | ']' | '{' | '}'
            | '~' | '=' | '-' | '+' | '/' | '.' | '(' | ')' => {
                out.push('\\');
                out.push(c);
            }
            '\r' => {}
            '\n' => out.push(' '),
            _ => out.push(c),
        }
    }
    out
}

/// Stringa letterale Typst (tra virgolette).
fn str_lit(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            '\r' => {}
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

fn prefix_lines(marker: &str, body: &str) -> String {
    let indent = " ".repeat(marker.chars().count());
    let mut out = String::new();
    for (index, line) in body.lines().enumerate() {
        if index == 0 {
            out.push_str(marker);
            out.push_str(line);
        } else if line.is_empty() {
            out.push('\n');
            continue;
        } else {
            out.push_str(&indent);
            out.push_str(line);
        }
        out.push('\n');
    }
    if body.is_empty() {
        out.push_str(marker.trim_end());
        out.push('\n');
    }
    out.trim_end_matches('\n').to_string()
}

struct Converter {
    diagrams: HashMap<String, String>,
    base_dir: Option<PathBuf>,
    images: Vec<(String, Vec<u8>)>,
    footnotes: HashMap<String, String>,
}

impl Converter {
    fn inline_children<'a>(&mut self, node: &'a AstNode<'a>) -> String {
        let mut out = String::new();
        for child in node.children() {
            out.push_str(&self.inline(child));
        }
        out
    }

    fn plain_text<'a>(&self, node: &'a AstNode<'a>) -> String {
        let mut out = String::new();
        for descendant in node.descendants() {
            if let NodeValue::Text(text) = &descendant.data().value {
                out.push_str(text);
            }
        }
        out
    }

    fn inline<'a>(&mut self, node: &'a AstNode<'a>) -> String {
        let data = node.data();
        match &data.value {
            NodeValue::Text(text) => esc(text),
            NodeValue::SoftBreak => " ".to_string(),
            NodeValue::LineBreak => "\\\n".to_string(),
            NodeValue::Code(code) => format!("#raw({})", str_lit(&code.literal)),
            NodeValue::Emph => format!("#emph[{}]", self.inline_children(node)),
            NodeValue::Strong => format!("#strong[{}]", self.inline_children(node)),
            NodeValue::Strikethrough => format!("#strike[{}]", self.inline_children(node)),
            NodeValue::Superscript => format!("#super[{}]", self.inline_children(node)),
            NodeValue::Subscript => format!("#sub[{}]", self.inline_children(node)),
            NodeValue::Link(link) => {
                let label = self.inline_children(node);
                let label = if label.is_empty() { esc(&link.url) } else { label };
                format!("#link({})[{}]", str_lit(&link.url), label)
            }
            NodeValue::Image(link) => {
                // image-block di Milkdown: il testo alternativo contiene il rapporto di scala ("0.55").
                let alt = self.plain_text(node);
                let ratio = alt
                    .trim()
                    .parse::<f32>()
                    .ok()
                    .filter(|r| alt.contains('.') && (0.1..=4.0).contains(r));
                let local = self
                    .base_dir
                    .as_deref()
                    .and_then(|dir| crate::read_local_image(dir, &link.url));
                match local {
                    Some((extension, bytes)) => {
                        let name = format!("img{}.{extension}", self.images.len());
                        self.images.push((name.clone(), bytes));
                        let mut call = format!("#fitimg({}", str_lit(&name));
                        if let Some(ratio) = ratio {
                            call.push_str(&format!(", ratio: {ratio}"));
                        }
                        if !link.title.is_empty() {
                            call.push_str(&format!(", caption: {}", str_lit(&link.title)));
                        }
                        call.push(')');
                        call
                    }
                    None if ratio.is_some() => format!(
                        "#text(fill: luma(140))[{}]",
                        esc(&format!("[immagine non trovata: {}]", link.url))
                    ),
                    None => self.inline_children(node),
                }
            }
            NodeValue::FootnoteReference(reference) => match self.footnotes.get(&reference.name) {
                Some(content) => format!("#footnote[{content}]"),
                None => String::new(),
            },
            NodeValue::Math(math) => format!("#raw({})", str_lit(&math.literal)),
            NodeValue::HtmlInline(_) | NodeValue::Raw(_) => String::new(),
            _ => self.inline_children(node),
        }
    }

    fn blocks<'a>(&mut self, node: &'a AstNode<'a>) -> String {
        let mut out = String::new();
        for child in node.children() {
            out.push_str(&self.block(child));
        }
        out
    }

    fn item_body<'a>(&mut self, item: &'a AstNode<'a>) -> String {
        let task = match &item.data().value {
            NodeValue::TaskItem(task) => Some(task.symbol.is_some()),
            _ => None,
        };
        let body = self.blocks(item);
        let body = body.trim_end_matches('\n');
        match task {
            Some(true) => format!("\u{2611} {body}"),
            Some(false) => format!("\u{2610} {body}"),
            None => body.to_string(),
        }
    }

    fn block<'a>(&mut self, node: &'a AstNode<'a>) -> String {
        let data = node.data();
        match &data.value {
            NodeValue::Paragraph => format!("{}\n\n", self.inline_children(node)),
            NodeValue::Heading(heading) => {
                let marks = "=".repeat(usize::from(heading.level.clamp(1, 6)));
                format!("{marks} {}\n\n", self.inline_children(node))
            }
            NodeValue::CodeBlock(code) if crate::is_mermaid(&code.info) && self.diagrams.contains_key(code.literal.trim()) => {
                let svg = crate::normalize_svg(&self.diagrams[code.literal.trim()]);
                let name = format!("diag{}.svg", self.images.len());
                self.images.push((name.clone(), svg.into_bytes()));
                format!("#fitimg({})\n\n", str_lit(&name))
            }
            NodeValue::CodeBlock(code) => {
                let lang = code.info.split_whitespace().next().unwrap_or("");
                let literal = code.literal.trim_end_matches('\n');
                let longest = literal
                    .split(|c| c != '`')
                    .map(str::len)
                    .max()
                    .unwrap_or(0);
                let fence = "`".repeat((longest + 1).max(3));
                format!("{fence}{lang}\n{literal}\n{fence}\n\n")
            }
            NodeValue::BlockQuote => format!("#bq[\n{}]\n\n", self.blocks(node)),
            NodeValue::List(list) => {
                let mut out = String::new();
                let mut number = list.start.max(1);
                for item in node.children() {
                    let body = self.item_body(item);
                    let marker = match list.list_type {
                        ListType::Bullet => "- ".to_string(),
                        ListType::Ordered => {
                            let marker = format!("{number}. ");
                            number += 1;
                            marker
                        }
                    };
                    out.push_str(&prefix_lines(&marker, &body));
                    out.push('\n');
                }
                out.push('\n');
                out
            }
            NodeValue::ThematicBreak => {
                "#line(length: 100%, stroke: 0.5pt + luma(190))\n\n".to_string()
            }
            NodeValue::Table(table) => {
                let columns = table.num_columns.max(1);
                let mut aligns: Vec<&str> = table
                    .alignments
                    .iter()
                    .map(|a| match a {
                        TableAlignment::Center => "center",
                        TableAlignment::Right => "right",
                        _ => "left",
                    })
                    .collect();
                aligns.resize(columns, "left");
                let mut out = format!(
                    "#table(\n  columns: {columns},\n  align: ({},),\n",
                    aligns.join(", ")
                );
                for row in node.children() {
                    let header = matches!(row.data().value, NodeValue::TableRow(true));
                    let mut cells = Vec::new();
                    for cell in row.children() {
                        cells.push(format!("[{}]", self.inline_children(cell)));
                    }
                    let cells = cells.join(", ");
                    if header {
                        out.push_str(&format!("  table.header({cells}),\n"));
                    } else {
                        out.push_str(&format!("  {cells},\n"));
                    }
                }
                out.push_str(")\n\n");
                out
            }
            NodeValue::FootnoteDefinition(_)
            | NodeValue::HtmlBlock(_)
            | NodeValue::FrontMatter(_) => String::new(),
            _ => self.blocks(node),
        }
    }

    /// Contenuto delle note a piè di pagina, indicizzato per nome.
    fn collect_footnotes<'a>(&mut self, root: &'a AstNode<'a>) {
        for node in root.descendants() {
            let name = match &node.data().value {
                NodeValue::FootnoteDefinition(definition) => definition.name.clone(),
                _ => continue,
            };
            let mut parts = Vec::new();
            for child in node.children() {
                parts.push(self.inline_children(child));
            }
            self.footnotes.insert(name, parts.join(" "));
        }
    }
}

/// Testo di un campo header/footer con segnaposto {title} {date} {page} {pages}.
fn template_to_typst(template: &str, title: &str, date: &str) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&esc(&rest[..start]));
        let after = &rest[start..];
        if let Some(next) = after.strip_prefix("{page}") {
            out.push_str("#counter(page).display()");
            rest = next;
        } else if let Some(next) = after.strip_prefix("{pages}") {
            out.push_str("#counter(page).final().first()");
            rest = next;
        } else if let Some(next) = after.strip_prefix("{title}") {
            out.push_str(&esc(title));
            rest = next;
        } else if let Some(next) = after.strip_prefix("{date}") {
            out.push_str(&esc(date));
            rest = next;
        } else {
            out.push_str(&esc("{"));
            rest = &after[1..];
        }
    }
    out.push_str(&esc(rest));
    out
}

fn band(cells: &[String], title: &str, date: &str) -> String {
    if cells.iter().all(|c| c.trim().is_empty()) {
        return "none".to_string();
    }
    let cell = |index: usize| {
        let text = cells.get(index).map(String::as_str).unwrap_or("");
        format!("[{}]", template_to_typst(text, title, date))
    };
    format!(
        "context text(size: 8.5pt, fill: luma(110), grid(columns: (1fr, 1fr, 1fr), \
         align: (left, center, right), {}, {}, {}))",
        cell(0),
        cell(1),
        cell(2)
    )
}

fn preamble(options: &PdfExportOptions) -> String {
    let paper = if options.paper.eq_ignore_ascii_case("letter") { "us-letter" } else { "a4" };
    let margin = options.margin_mm.clamp(5.0, 60.0);
    format!(
        r##"#set document(title: {title})
#set page(paper: "{paper}", margin: {margin}mm, header: {header}, footer: {footer})
#set text(font: ("Open Sans", "Libertinus Serif", "DejaVu Sans Mono"), size: 10.5pt, lang: "it")
#set par(leading: 0.75em, spacing: 1.15em)
#show heading: set block(above: 1.4em, below: 0.7em)
#show heading.where(level: 1): set text(size: 22pt)
#show heading.where(level: 1): it => [#it #v(-0.55em) #line(length: 100%, stroke: 0.6pt + luma(205))]
#show heading.where(level: 2): set text(size: 17pt)
#show heading.where(level: 2): it => [#it #v(-0.55em) #line(length: 100%, stroke: 0.6pt + luma(205))]
#show heading.where(level: 3): set text(size: 14pt)
#show heading.where(level: 4): set text(size: 12pt)
#show heading.where(level: 5): set text(size: 10.5pt)
#show heading.where(level: 6): set text(size: 10.5pt, fill: luma(110))
#show raw: set text(font: ("DejaVu Sans Mono",), size: 8.8pt)
#show raw.where(block: false): it => box(fill: luma(240), inset: (x: 3pt), outset: (y: 3pt), radius: 2pt, it)
#show raw.where(block: true): it => block(width: 100%, fill: luma(246), stroke: 0.5pt + luma(222), radius: 3pt, inset: 9pt, it)
#show link: set text(fill: rgb("#1a5fb4"))
#set table(stroke: 0.5pt + luma(190), inset: 6pt)
#show table.cell.where(y: 0): set text(weight: "bold")
#show table: set block(above: 1em, below: 1em)
#set list(indent: 0.4em, body-indent: 0.6em, marker: ([•], [‣], [–]))
#set enum(indent: 0.4em, body-indent: 0.6em)
#let bq(body) = block(width: 100%, inset: (left: 12pt, y: 2pt), stroke: (left: 2.5pt + luma(200)), text(fill: luma(100), body))
#let fitimg(path, ratio: 1.0, caption: none) = layout(size => context {{
  let img = image(path)
  let natural = measure(img)
  let w = calc.min(natural.width, size.width) * ratio
  let h = w * (natural.height / natural.width)
  let max-h = page.height * 0.6
  if h > max-h {{ w = w * (max-h / h) }}
  block(breakable: false, width: 100%, align(center, {{
    image(path, width: w)
    if caption != none {{ v(0.3em); text(size: 9pt, fill: luma(110), caption) }}
  }}))
}})
"##,
        title = str_lit(&options.title),
        header = band(&options.header, &options.title, &options.date),
        footer = band(&options.footer, &options.title, &options.date),
    )
}

/// Sorgente Typst completo e immagini incorporate (nome -> byte).
pub fn markdown_to_typst(
    markdown: &str,
    options: &PdfExportOptions,
) -> (String, Vec<(String, Vec<u8>)>) {
    let mut comrak_options = Options::default();
    comrak_options.extension.table = true;
    comrak_options.extension.strikethrough = true;
    comrak_options.extension.tasklist = true;
    comrak_options.extension.autolink = true;
    comrak_options.extension.footnotes = true;

    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &comrak_options);

    let mut converter = Converter {
        diagrams: options.diagrams.clone(),
        base_dir: options.base_dir.as_deref().map(PathBuf::from),
        images: Vec::new(),
        footnotes: HashMap::new(),
    };
    converter.collect_footnotes(root);
    let body = converter.blocks(root);
    (format!("{}\n{}", preamble(options), body), converter.images)
}

// ---------------------------------------------------------------------------
// Compilazione Typst
// ---------------------------------------------------------------------------

struct FontData {
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
}

fn fonts() -> &'static FontData {
    static FONTS: OnceLock<FontData> = OnceLock::new();
    FONTS.get_or_init(|| {
        let mut book = FontBook::new();
        let mut fonts = Vec::new();
        let embedded = OPEN_SANS.iter().copied().chain(typst_assets::fonts());
        for data in embedded {
            for font in Font::iter(Bytes::new(data)) {
                book.push(font.info().clone());
                fonts.push(font);
            }
        }
        FontData { book: LazyHash::new(book), fonts }
    })
}

fn library() -> &'static LazyHash<Library> {
    static LIBRARY: OnceLock<LazyHash<Library>> = OnceLock::new();
    LIBRARY.get_or_init(|| LazyHash::new(Library::default()))
}

struct SnibWorld {
    main: Source,
    files: HashMap<String, Bytes>,
}

impl World for SnibWorld {
    fn library(&self) -> &LazyHash<Library> {
        library()
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &fonts().book
    }

    fn main(&self) -> FileId {
        self.main.id()
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main.id() {
            Ok(self.main.clone())
        } else {
            Err(FileError::NotFound(id.vpath().get_without_slash().into()))
        }
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if id == self.main.id() {
            return Ok(Bytes::from_string(self.main.text().to_string()));
        }
        let name = id.vpath().get_without_slash();
        self.files
            .get(name)
            .cloned()
            .ok_or_else(|| FileError::NotFound(Path::new(name).into()))
    }

    fn font(&self, index: usize) -> Option<Font> {
        fonts().fonts.get(index).cloned()
    }

    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        None
    }
}

fn describe(world: &SnibWorld, errors: &[SourceDiagnostic]) -> String {
    use typst::WorldExt;

    errors
        .iter()
        .take(5)
        .map(|diagnostic| {
            let line = world
                .range(diagnostic.span)
                .map(|range| world.main.text()[..range.start].matches('\n').count() + 1);
            match line {
                Some(line) => format!("riga {line}: {}", diagnostic.message),
                None => diagnostic.message.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn compile_document(
    source: String,
    images: Vec<(String, Vec<u8>)>,
) -> Result<(SnibWorld, PagedDocument), String> {
    let path = VirtualPath::new("/main.typ").map_err(|e| e.to_string())?;
    let id = FileId::new(RootedPath::new(VirtualRoot::Project, path));
    let world = SnibWorld {
        main: Source::new(id, source),
        files: images
            .into_iter()
            .map(|(name, bytes)| (name, Bytes::new(bytes)))
            .collect(),
    };

    let document = typst::compile::<PagedDocument>(&world)
        .output
        .map_err(|errors| format!("Typst: {}", describe(&world, &errors)))?;
    Ok((world, document))
}

fn compile(source: String, images: Vec<(String, Vec<u8>)>) -> Result<Vec<u8>, String> {
    let (world, document) = compile_document(source, images)?;
    typst_pdf::pdf(&document, &typst_pdf::PdfOptions::default())
        .map_err(|errors| format!("PDF: {}", describe(&world, &errors)))
}

/// Markdown -> byte del PDF.
pub fn build(markdown: &str, options: &PdfExportOptions) -> Result<Vec<u8>, String> {
    let (source, images) = markdown_to_typst(markdown, options);
    compile(source, images)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> PdfExportOptions {
        PdfExportOptions {
            paper: "a4".to_string(),
            margin_mm: 22.0,
            header: vec!["".into(), "".into(), "{title}".into()],
            footer: vec!["{date}".into(), "{page} / {pages}".into(), "".into()],
            title: "Prova #1 [x]".to_string(),
            date: "14.10.2026".to_string(),
            base_dir: None,
            diagrams: HashMap::new(),
        }
    }

    #[test]
    fn escapes_markup_characters() {
        assert_eq!(esc("1. a - b # c $ d * e _ f"), "1\\. a \\- b \\# c \\$ d \\* e \\_ f");
        assert_eq!(esc("[x](y)"), "\\[x\\]\\(y\\)");
    }

    #[test]
    fn template_placeholders() {
        let out = template_to_typst("p. {page}/{pages} {title} {x}", "T", "D");
        assert!(out.contains("#counter(page).display()"));
        assert!(out.contains("#counter(page).final().first()"));
        assert!(out.contains("T"));
        assert!(out.contains("\\{x\\}"));
    }

    #[test]
    fn compiles_full_document_to_pdf() {
        let markdown = "\
# Titolo *con* `codice`

Paragrafo con **grassetto**, ~~barrato~~, [link](https://example.com) e nota[^1].
1. non una lista? # $ [ ] { } < > @ ~ = - + / . ( )

> citazione
> su due righe

- uno
  - annidato
- [x] fatto
- [ ] da fare

1. primo
2. secondo

| a | b | c |
|:--|:-:|--:|
| 1 | 2 | 3 |

```rust
fn main() { println!(\"ciao\"); }
```

---

![manca](non-esiste.png)

[^1]: Testo della nota.
";
        let pdf = build(markdown, &options()).expect("compilazione PDF");
        assert!(pdf.starts_with(b"%PDF"));
        assert!(pdf.len() > 2000);
        if let Ok(out) = std::env::var("SNIB_PDF_OUT") {
            std::fs::write(out, &pdf).unwrap();
        }
    }

    fn pages_for(markdown: &str, svg: &str) -> usize {
        let dir = std::env::temp_dir().join(format!("s-nib-pdf-img-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("big.svg"), svg).unwrap();
        let mut opts = options();
        opts.base_dir = Some(dir.to_string_lossy().into_owned());
        let (source, images) = markdown_to_typst(markdown, &opts);
        assert_eq!(images.len(), 1, "immagine non trovata");
        let (_, document) = compile_document(source, images).expect("compilazione");
        if let Ok(out) = std::env::var("SNIB_PDF_IMG_OUT") {
            let pdf = typst_pdf::pdf(&document, &typst_pdf::PdfOptions::default()).unwrap();
            std::fs::write(format!("{out}-{}.pdf", markdown.len()), pdf).unwrap();
        }
        std::fs::remove_dir_all(&dir).unwrap();
        document.pages().len()
    }

    #[test]
    fn tall_images_stay_on_the_page_and_honor_ratio() {
        let tall = r##"<svg xmlns="http://www.w3.org/2000/svg" width="900" height="2800"><rect width="900" height="2800" fill="#369"/></svg>"##;
        // senza rapporto, molto alta: ridotta per restare in una pagina
        assert_eq!(pages_for("Intro\n\n![](big.svg)\n\nFine", tall), 1);
        // con rapporto di scala e didascalia (formato image-block di Milkdown)
        assert_eq!(pages_for("Intro\n\n![0.40](big.svg \"Didascalia\")\n\nFine", tall), 1);
        // il testo alternativo numerico non deve comparire come testo
        let wide = r##"<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="400"><rect width="3000" height="400" fill="#963"/></svg>"##;
        assert_eq!(pages_for("![1.00](big.svg)", wide), 1);
    }

    #[test]
    fn mermaid_diagrams_render_in_pdf() {
        let code = "flowchart TD\n A --> B";
        let mut opts = options();
        opts.diagrams.insert(code.to_string(), include_str!("../tests/fixtures/mermaid-flow.svg").to_string());
        opts.diagrams.insert("sequenceDiagram\n U->>A: x".to_string(), include_str!("../tests/fixtures/mermaid-sequence.svg").to_string());
        let markdown = format!("# Diagrammi\n\n```mermaid\n{code}\n```\n\nTesto.\n\n```mermaid\nsequenceDiagram\n U->>A: x\n```\n");
        let (source, images) = markdown_to_typst(&markdown, &opts);
        assert_eq!(images.len(), 2);
        assert!(source.contains("#fitimg(\"diag0.svg\")"));
        let (_, document) = compile_document(source, images).expect("compilazione");
        let pdf = typst_pdf::pdf(&document, &typst_pdf::PdfOptions::default()).unwrap();
        assert!(pdf.starts_with(b"%PDF"));
        if let Ok(out) = std::env::var("SNIB_PDF_MERMAID_OUT") {
            std::fs::write(out, pdf).unwrap();
        }
    }

    #[test]
    fn empty_document_and_no_header_footer() {
        let mut opts = options();
        opts.header = vec![String::new(); 3];
        opts.footer = vec![String::new(); 3];
        let pdf = build("", &opts).expect("documento vuoto");
        assert!(pdf.starts_with(b"%PDF"));
    }
}

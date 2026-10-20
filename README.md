# s-nib

Open source (GPL-3.0-or-later) WYSIWYG Markdown editor for Linux, Windows and macOS.

You write the formatted document directly: headings look like headings, bold looks bold, and the Markdown syntax only shows up under the cursor. The file stays plain Markdown, readable by any other tool.

Status: under development, used on Linux, tried on Windows. Packages: `.deb` for Linux, installer and standalone exe for Windows, `.dmg` for macOS, built by the GitHub Actions workflows in `.github/workflows/`. The macOS build has not been tried.

## Features

### Editing

- WYSIWYG editor (Milkdown/ProseMirror) with CommonMark and GFM: tables, task lists, strikethrough, footnotes
- Inline syntax visible under the cursor (`**`, `*`, `` ` ``, `~~`, `[text](url)`, heading `#`)
- Code blocks with syntax highlighting (CodeMirror), language picker and Copy button
- Inline code `` `text` `` also works when the backtick is typed with a dead key (Shift + accent key, then space)
- LaTeX formulas (KaTeX): `$x^2$` inline, `$$` as a block, editable in place with a click
- Mermaid diagrams: a code block with the `mermaid` language and a preview below the code (SVG labels, light theme)
- Images: relative paths are displayed, paste and drop (saved in `assets/` next to the `.md`), Insert > Image..., resize and caption
- Insert > Table...: toolbar button with a rows x columns dialog
- Right-click menu (Paste reads the system clipboard through the app, also inside code blocks): clipboard, bold/italic/strikethrough/code, paragraph/headings/lists/quote/code block, inside a table: add row above/below, column left/right, column alignment, delete row/column/table, GFM alerts (`> [!NOTE]`, tip, important, warning, caution) shown in the editor and exported to HTML and PDF
- Opens files passed on the command line (`s-nib notes.md`) and registers as a Markdown handler (file manager "Open with"; Linux and Windows)
- Source mode (Ctrl+/) to edit the raw Markdown
- Find (Ctrl+F) in the document and in source mode: match count, next/previous (Enter, Shift+Enter), match case; code blocks are not searched
- Find and replace (Ctrl+H) in the document and in source mode: replace one match (Enter) or all (Ctrl+Enter); code blocks are not searched
- Folder search (Ctrl+Shift+H, sidebar Search tab): text search in all Markdown files of the open folder, up to 500 results; a click opens the file with the text highlighted
- Command palette (Ctrl+Shift+P): every menu action searchable by name, with its shortcut
- YAML front matter (`---` block at the start of the file): shown in a collapsible panel above the document instead of being parsed as Markdown, kept on save and left out of the exports; Insert > Front matter (YAML) adds one
- Links: Ctrl+click on a link opens a relative Markdown link in the same pane (Ctrl+Shift+click beside it) and a web or mailto link in the browser; the sidebar Links tab lists the documents of the open folder that link to the active file (backlinks, Markdown `[text](file.md)` links only)
- Integrated terminal (Ctrl+Shift+T, View > Terminal): a shell in the folder selected in the sidebar tree (click a folder; right-click > Open terminal here restarts the shell there), else in the open folder (`$SHELL`, PowerShell on Windows) in a panel below the documents (drag its top edge to resize, the height is remembered); up to 3 terminals side by side with draggable dividers (Ctrl+Shift+5, the `+` in the bar, View > Split terminal; each has its own `✕` to end it, `▾` hides the panel); hiding keeps the shells running, `exit` closes that terminal and the panel hides when none is left; with the terminal focused Ctrl+N/O/S/W/P/Q go to the shell instead of the menu; selecting text copies it to the PRIMARY selection and the middle mouse button pastes it (shared with other terminals on Linux); dropping files from the file manager onto the panel pastes their paths
- Sidebar tree right-click menu: on a folder Open terminal here, Open in file manager, Open in VSCodium or VS Code (only if `codium` or `code` is installed) and Copy absolute path; on a file Copy absolute path (also set as PRIMARY selection on Linux)
- Status bar with word and character counts, also for the selection, and a Terminal button that shows or hides the terminal panel
- External changes: if the open file is modified or deleted outside s-nib, a bar offers Reload or Ignore (checked on window focus and every 2 s while focused)
- Text zoom: Ctrl + mouse wheel, Ctrl +/-, Ctrl+0 to reset (remembered); Ctrl + wheel over the sidebar zooms the sidebar separately, over the terminal (or with it focused, Ctrl +/-/0) the terminal font size (8-32, remembered)
- Unlimited undo and redo (per pane)
- Split view (Ctrl+\\): two documents side by side, each with its own undo history and autosave; Ctrl+click a file in the sidebar opens it in the other pane; the divider can be dragged; F6 switches pane, Ctrl+Shift+\\ swaps left and right, Ctrl+W closes the active pane; the same file is never opened twice
- Autosave (File > Autosave, on by default): a named file is saved 2 s after the last keystroke; skipped if the file changed on disk
- Version history (File > Version history...): a copy of the document is kept at save time, at most one every 5 minutes and the last 30 per file; the dialog previews a version and restores it as an unsaved change (the current text is kept as a version first)
- Crash recovery: unsaved documents (including untitled ones) are copied to the app data folder and offered back at the next start; removed on a clean exit
- Spellcheck (View > Spellcheck): English, Italian or both, underline only (no suggestions menu); on Linux it needs the enchant/hunspell dictionaries (`sudo apt install hunspell-it hunspell-en-us`), on Windows and macOS it uses the system dictionaries

### Navigation and interface

- Resizable sidebar with a folder tree (7 recent folders) and the document outline; the last folder is reopened at startup (unless a file is passed on the command line); the tree refreshes when the window regains focus and every 2 seconds while focused, so files and folders created, renamed or deleted outside s-nib appear or disappear while the open folders stay open
- Toolbar and native menu, with Help > Shortcuts and tips (F1: shortcuts grouped by area and a few hidden gestures) and Help > About s-nib (version, license notice and full GPL text); a toast and an About link announce newer releases (checked at startup, silent if offline)
- Themes: GitHub, Newsprint, Night, Slate, Automatic (follows the system); Open Sans font bundled

### Export

- All exports live in the **Export** menu
- Self-contained **HTML**: active theme, highlighted code blocks, local images with their scale, Mermaid diagrams and formulas (SVG) embedded, raw HTML from the source dropped
- **PDF** generated in-process with Typst, with no browser and no print dialog:
  - A4 or Letter, configurable margin
  - three-field header and footer with the placeholders `{title}` `{date}` `{page}` `{pages}`
  - global defaults (Export > Default PDF settings), which can be overridden for a single document at export time without touching the defaults
  - highlighted code blocks, tables, lists, quotes, alerts, footnotes, images with scale and caption, vector Mermaid diagrams and formulas
- **Word (DOCX)** and **OpenDocument (ODT)** through [pandoc](https://pandoc.org), which must be installed separately (`sudo apt install pandoc`); if it is missing, the export shows how to install it. Formulas become native equations; Mermaid diagrams stay as code and alerts as plain quotes
- **Print** with the system dialog (Ctrl+P)

## Shortcuts

On macOS use Cmd instead of Ctrl.

- Ctrl+N: new document
- Ctrl+W: close the active pane
- Ctrl+\\: split view on or off
- Ctrl+Shift+\\: swap left and right panes
- F6: switch pane
- Ctrl+O: open file
- Ctrl+Shift+O: open folder
- Ctrl+S: save
- Ctrl+Shift+S: save as
- Ctrl+Shift+E: export as PDF
- Ctrl+P: print
- Ctrl+Shift+I: insert image
- Ctrl+Shift+Y: add or edit the YAML front matter
- Ctrl+/: source mode
- Ctrl+F: find; Ctrl+H: find and replace (Enter replaces one, Ctrl+Enter all)
- Ctrl+Shift+H: search in the open folder
- In code blocks: Ctrl+Shift+C toggle comment; Ctrl+Alt+F re-indent the block; Ctrl+Shift+Up/Down duplicate line; Alt+Shift+Up/Down move line; Ctrl+X without selection cuts the line
- Ctrl+Shift+L: show or hide the sidebar
- Ctrl+Shift+P: command palette (type to filter, Enter to run)
- Ctrl+Shift+T: show or hide the terminal
- Ctrl+Shift+5: split the terminal (up to 3)
- Ctrl + mouse wheel, Ctrl+`+`, Ctrl+`-`: zoom the text (wheel over the sidebar: zoom the sidebar); Ctrl+0: reset
- Ctrl+Q: quit

## Install and development

Prerequisites: Node.js, Rust (rustup) and the Tauri 2 dependencies for your system
(see https://tauri.app/start/prerequisites/). On Debian and Ubuntu:

```
sudo apt install build-essential libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev
```

Commands:

```
npm install
npm run tauri dev      # run in development
npm run build          # frontend only (type check and bundle)
npm run tauri build    # packages for the current system
npm run tauri build -- --bundles deb    # Debian package only
cd src-tauri && cargo test    # Rust tests
```

The CI workflows (`linux`, `windows`, `macos`) run on version tags (`v*`) or manually, and publish the packages as build artifacts.

The first build is long (Typst and Tauri). In development the Typst crates are optimized even in debug builds.

## Database connector (optional, experimental)

Opens and edits Markdown stored in the column of a MariaDB table (for example course notes kept by another application). It is not part of the released packages and comes without support: build it with `npm run tauri dev -- --features db` or `npm run tauri build -- --features db`.

- Connections, tables and columns are described in `databases.toml` in the app configuration folder (Linux: `~/.config/ch.ssigno.s-nib/`, macOS: `~/Library/Application Support/ch.ssigno.s-nib/`, Windows: `%APPDATA%\ch.ssigno.s-nib\`; only Linux is tested). Start from the commented `databases.toml.example` in the repository root: `mkdir -p ~/.config/ch.ssigno.s-nib && cp databases.toml.example ~/.config/ch.ssigno.s-nib/databases.toml`. Nothing is hard coded. The password is not in that file: s-nib asks for it the first time and keeps it in the system keyring (Secret Service on Linux), asking again if the server refuses it
- The **Database** tab appears in the sidebar only when the build has the feature and the file lists a connection. Click a row to open it, Ctrl+click to open it in the other pane; right-click a row to save it as a local `.md` file or export it to HTML, PDF, Word or OpenDocument without opening it (the suggested file name is the row title)
- Ctrl+S writes the text back to the row. There is no autosave, version history or crash recovery for these documents, and Save as detaches the document from the database
- A save only goes through if the row is unchanged since it was opened (a hash of the stored text is compared inside a transaction); otherwise s-nib asks whether to overwrite. Text longer than the column is refused
- Connections are read only unless `write = true`. Use a database user with the least privileges that work (`SELECT` and `UPDATE` on the content column), ideally on a view that selects only the rows to edit

```toml
[[connection]]
name = "notes"          # also the keyring entry
host = "127.0.0.1"
port = 3306             # default
database = "mydb"
user = "snib"
tls = false             # true to encrypt; tls_ca = "/path/ca.pem" for a private certificate
write = false           # true to allow saving

[[connection.table]]
name = "documents"      # table or view
id = "id"               # default
content = "body"        # the Markdown column (text, mediumtext, longtext, varchar or char)
title = "title"         # optional: list label (else the first line of the text, else #id)
group = "course"        # optional: headers in the list, sorted first
order = ["chapter_order"]   # optional: column or list of columns, the id comes last
touch = "updated_at"    # optional: set to NOW() on every save
filter = ["deleted_at IS NULL", "user_id = 1"]   # optional: conditions on one column each, all must hold
```

The example file is checked by a test, so it always parses.

Table and column names may only contain letters, digits and `_`, and are checked against `information_schema` before use; `filter` accepts only `col IS NULL`, `col IS NOT NULL`, `col = 1` and `col = 'text'`. Values always travel as bound parameters. If a table has foreign keys from other tables, give the database user a view instead of the table and join with sub-selects: MariaDB checks privileges on the referencing tables when an `UPDATE` goes through a prepared statement, so s-nib sends the values in session variables and a plain `UPDATE`.

## Data and configuration

- `databases.toml` (optional connector, see above) lives in the same folder; it holds no passwords
- The default PDF settings live in `pdf-settings.json` in the app configuration folder (Linux: `~/.config/ch.ssigno.s-nib/`)
- Theme, sidebar width, recent folders, zoom and autosave/spellcheck settings live in the webview data
- The saved versions are in `history/` in the app data folder, one subfolder per document
- The recovery snapshot of unsaved documents is `session.json` in the app data folder, removed on a clean exit
- The only network request, unless remote images are enabled, is the update check at startup (`https://www.ssigno.ch/downloads/latest.json`); nothing is sent besides the request itself, and it fails silently when offline
- Pasted images go in `assets/` next to the document, with cleaned names and without overwriting existing files
- Line endings: CRLF files are normalized to LF when loaded (CodeMirror and ProseMirror disagree on `\r`); empty paragraphs are not saved as `<br />`

## Security

- Content security policy set in `src-tauri/tauri.conf.json` (`default-src 'self'`, `form-action`, `frame-ancestors`); `style-src 'unsafe-inline'` is needed by CodeMirror and ProseMirror
- Read, save and export commands accept only absolute paths with an allowed extension (Markdown, PDF, HTML, DOCX, ODT) outside sensitive folders (`.ssh`, `.config`, `.local` and similar); symlinks are judged by their target. Saving a file name without extension is refused, and documents inside those folders cannot be opened
- The folder tree, folder search and backlinks refuse the same sensitive folders
- "Open in file manager" and "Open in VSCodium or VS Code" accept only existing absolute folders
- The database connector is compiled only with the `db` feature, so release builds contain no database code or commands; connections are read only by default, identifiers are validated and quoted, values are bound parameters and passwords stay in the system keyring
- SVG (Mermaid, formulas) is checked before being embedded in the HTML export
- Remote images are blocked by default (the CSP has no remote `img-src`, a placeholder is shown). File > Remote images turns them on: Rust then downloads `https:` images only (10 s timeout, 10 MB, PNG/JPEG/GIF/WebP, redirects stay on `https:`). While enabled, a hostile `.md` can reveal the IP address and the opening time; the local network is not filtered. The HTML export keeps remote links as written

## Project structure

- `src/main.ts`: editor, actions, files, themes
- `src/sidebar.ts`: file tree, recent folders, outline, folder search, resizing
- `src/search.ts`: find and replace (ProseMirror plugin and source mode)
- `src/split.ts`: draggable divider between the two panes
- `src/statusbar.ts`: word and character counts
- `src/context-menu.ts`, `src/alerts.ts`: right-click menu and GFM alerts
- `src/editor-plugins.ts`: inline syntax, focus and typewriter modes
- `src/math-plugin.ts`: formulas in the editor (nodes, KaTeX rendering, in-place editing)
- `src/math.ts`, `src/mathjax-render.ts`: formulas as SVG for the export (MathJax loaded on export only)
- `src/mermaid.ts`: Mermaid diagrams (preview and export)
- `src/images.ts`: local images (blobs from Rust), paste and drop, insertion
- `src/export.ts`, `src/export.css`: HTML export and print
- `src/highlight.ts`: code highlighting for the HTML export
- `src/pdf-export.ts`, `src/toast.ts`: PDF dialog and messages
- `src/help.ts`: Shortcuts and tips dialog (static list, keep in sync with the shortcuts above)
- `src/about.ts`: About dialog (version, license text loaded on demand)
- `src/update-check.ts`: update notice at startup, reads `https://www.ssigno.ch/downloads/latest.json`
- `src/themes.css`, `src/theme.css`, `src/styles.css`: themes, document, layout
- `src-tauri/src/lib.rs`: Rust commands (files, folders, images, HTML rendering, settings) and native menu
- `src/sources.ts`: `DocSource` and remote panes (documents that do not come from a file)
- `src/db-source.ts`, `src-tauri/src/db.rs`: optional database connector (Database tab, MariaDB access; feature `db`)
- `src/terminal.ts`: terminal panel with up to 3 terminals (xterm.js)
- `src-tauri/src/terminal.rs`: shells in pseudo-terminals, one per slot (portable-pty), streamed to the webview
- `src-tauri/src/pdf.rs`: Markdown (comrak) to Typst source and PDF compilation
- `src-tauri/fonts/`: Open Sans (OFL) for the PDF
- `src-tauri/linux/s-nib.desktop`: custom desktop entry for the `.deb` (MIME types and `%F`, so file managers offer s-nib for Markdown)
- `assets/icon.svg`: icon source (orange nib on a slate background); to regenerate the sizes: `inkscape assets/icon.svg -o assets/icon.png -w 1024 -h 1024 && npx tauri icon assets/icon.png`, then delete the `android/` and `ios/` folders created in `src-tauri/icons/`

## Known limitations

- In the exported HTML the image scale is a fraction of the page width (images narrower than the page are not reduced)
- The PDF has its own style, not identical to the editor theme, and uses embedded fonts only: characters outside Open Sans, Libertinus and DejaVu may be missing
- Raw HTML and remote images are not included in the PDF
- Mermaid diagrams are rendered with the light theme and SVG labels; complex diagrams or invalid syntax stay as a code block in the export
- Formulas are shown with KaTeX in the editor and rendered with MathJax in the export: small differences in appearance, and a formula with invalid LaTeX stays as text in the export
- Database documents: no autosave, history or crash recovery; mixed line endings in a row become all CRLF when the row had any
- Images require an already saved document (a folder is needed to create `assets/`)
- Focus and typewriter modes exist in the code but are hidden from the interface
- On Linux, rendering depends on WebKitGTK

## Roadmap

- First test of the macOS build
- A `copyright` file in the `.deb` package
- Possible DOCX and other export formats

## Credits

Developed with the assistance of Claude Sonnet 5.5 (Anthropic).

## License

Copyright (c) 2026 signo.

s-nib is free software: you can redistribute it and modify it under the terms of the GNU General Public License, version 3 or (at your option) any later version (see `LICENSE`). There is no warranty.

Earlier versions (up to commit `1b0de37`) were distributed under the MIT license; that code can still be used under the terms it was published with.

Third-party components, all with licenses compatible with GPL-3.0:

- Tauri: MIT or Apache-2.0
- Milkdown and ProseMirror: MIT
- CodeMirror: MIT
- Typst: Apache-2.0
- comrak: BSD-2-Clause
- Mermaid: MIT
- KaTeX: MIT
- MathJax: Apache-2.0
- Open Sans (bundled in `src-tauri/fonts/` and via `@fontsource`): SIL Open Font License 1.1 (text in `src-tauri/fonts/OFL.txt`)

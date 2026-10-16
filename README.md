# s-nib

Open source (GPL-3.0-or-later) WYSIWYG Markdown editor for Linux, Windows and macOS.

You write the formatted document directly: headings look like headings, bold looks bold, and the Markdown syntax only shows up under the cursor. The file stays plain Markdown, readable by any other tool.

Status: under development, used on Linux so far. Packages: `.deb` for Linux, installer and standalone exe for Windows, `.dmg` for macOS, built by the GitHub Actions workflows in `.github/workflows/`. Windows and macOS have not been tried.

## Features

### Editing

- WYSIWYG editor (Milkdown/ProseMirror) with CommonMark and GFM: tables, task lists, strikethrough, footnotes
- Inline syntax visible under the cursor (`**`, `*`, `` ` ``, `~~`, `[text](url)`, heading `#`)
- Code blocks with syntax highlighting (CodeMirror), language picker and Copy button
- LaTeX formulas (KaTeX): `$x^2$` inline, `$$` as a block, editable in place with a click
- Mermaid diagrams: a code block with the `mermaid` language and a preview below the code (SVG labels, light theme)
- Images: relative paths are displayed, paste and drop (saved in `assets/` next to the `.md`), Insert > Image..., resize and caption
- Insert > Table...: toolbar button with a rows x columns dialog
- Right-click menu: clipboard, bold/italic/strikethrough/code, paragraph/headings/lists/quote/code block, GFM alerts (`> [!NOTE]`, tip, important, warning, caution) shown in the editor and exported to HTML and PDF
- Opens files passed on the command line (`s-nib notes.md`) and registers as a Markdown handler (file manager "Open with"; Linux and Windows)
- Source mode (Ctrl+/) to edit the raw Markdown
- Find (Ctrl+F) in the document and in source mode: match count, next/previous (Enter, Shift+Enter), match case; code blocks are not searched
- Find and replace (Ctrl+H) in the document and in source mode: replace one match (Enter) or all (Ctrl+Enter); code blocks are not searched
- Folder search (Ctrl+Shift+F, sidebar Search tab): text search in all Markdown files of the open folder, up to 500 results; a click opens the file with the text highlighted
- Status bar with word and character counts, also for the selection
- External changes: if the open file is modified or deleted outside s-nib, a bar offers Reload or Ignore (checked on window focus and every 2 s while focused)
- Text zoom: Ctrl + mouse wheel, Ctrl +/-, Ctrl+0 to reset (remembered); Ctrl + wheel over the sidebar zooms the sidebar separately
- Unlimited undo and redo (per pane)
- Split view (Ctrl+\\): two documents side by side, each with its own undo history and autosave; Ctrl+click a file in the sidebar opens it in the other pane; the divider can be dragged; F6 switches pane, Ctrl+Shift+\\ swaps left and right, Ctrl+W closes the active pane; the same file is never opened twice
- Autosave (File > Autosave, on by default): a named file is saved 2 s after the last keystroke; skipped if the file changed on disk
- Crash recovery: unsaved documents (including untitled ones) are copied to the app data folder and offered back at the next start; removed on a clean exit
- Spellcheck (View > Spellcheck): English, Italian or both, underline only (no suggestions menu); on Linux it needs the enchant/hunspell dictionaries (`sudo apt install hunspell-it hunspell-en-us`), on Windows and macOS it uses the system dictionaries

### Navigation and interface

- Resizable sidebar with a folder tree (7 recent folders) and the document outline
- Toolbar and native menu, with Help > About s-nib (version, license notice and full GPL text); a toast and an About link announce newer releases (checked at startup, silent if offline)
- Themes: GitHub, Newsprint, Night, Slate, Automatic (follows the system); Open Sans font bundled

### Export

- Self-contained **HTML**: active theme, highlighted code blocks, local images with their scale, Mermaid diagrams and formulas (SVG) embedded, raw HTML from the source dropped
- **PDF** generated in-process with Typst, with no browser and no print dialog:
  - A4 or Letter, configurable margin
  - three-field header and footer with the placeholders `{title}` `{date}` `{page}` `{pages}`
  - global defaults (File > Default PDF settings), which can be overridden for a single document at export time without touching the defaults
  - highlighted code blocks, tables, lists, quotes, alerts, footnotes, images with scale and caption, vector Mermaid diagrams and formulas
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
- Ctrl+/: source mode
- Ctrl+F: find; Ctrl+H: find and replace (Enter replaces one, Ctrl+Enter all)
- Ctrl+Shift+F: search in the open folder
- Ctrl+Shift+L: show or hide the sidebar
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

## Data and configuration

- The default PDF settings live in `pdf-settings.json` in the app configuration folder (Linux: `~/.config/ch.ssigno.s-nib/`)
- Theme, sidebar width, recent folders, zoom and autosave/spellcheck settings live in the webview data
- The recovery snapshot of unsaved documents is `session.json` in the app data folder, removed on a clean exit
- The only network request is the update check at startup (`https://www.ssigno.ch/downloads/latest.json`); nothing is sent besides the request itself, and it fails silently when offline
- Pasted images go in `assets/` next to the document, with cleaned names and without overwriting existing files

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
- `src/about.ts`: About dialog (version, license text loaded on demand)
- `src/update-check.ts`: update notice at startup, reads `https://www.ssigno.ch/downloads/latest.json`
- `src/themes.css`, `src/theme.css`, `src/styles.css`: themes, document, layout
- `src-tauri/src/lib.rs`: Rust commands (files, folders, images, HTML rendering, settings) and native menu
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
- Images require an already saved document (a folder is needed to create `assets/`)
- Focus and typewriter modes exist in the code but are hidden from the interface
- On Linux, rendering depends on WebKitGTK

## Roadmap

- First test of the Windows and macOS builds
- A `copyright` file in the `.deb` package
- Possible DOCX and other export formats

## Credits

Developed with the assistance of Claude Sonnet 5.5 (Anthropic).

## License

Copyright (c) 2026 signo.

s-nib is free software: you can redistribute it and modify it under the terms of the GNU General Public License, version 3 or (at your option) any later version (see `LICENSE`). There is no warranty.

Earlier versions (up to commit `7f282db`) were distributed under the MIT license; that code can still be used under the terms it was published with.

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

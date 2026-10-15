# s-nib

Open source (GPL-3.0-or-later) WYSIWYG Markdown editor for Linux, Windows and macOS.

You write the formatted document directly: headings look like headings, bold looks bold, and the Markdown syntax only shows up under the cursor. The file stays plain Markdown, readable by any other tool.

The name is a play on *signo* and *nib* (a pen nib).

Status: under development, used on Linux so far. Package: `.deb` for Linux; a Windows build script is ready but has not been run yet; macOS needs a Mac or a CI runner. Windows and macOS have not been tried.

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
- Text zoom: Ctrl + mouse wheel, Ctrl +/-, Ctrl+0 to reset (remembered)
- Unlimited undo and redo

### Navigation and interface

- Resizable sidebar with a folder tree (7 recent folders) and the document outline
- Toolbar and native menu, with Help > About s-nib (version, license notice and full GPL text)
- Themes: GitHub, Newsprint, Night, Slate, Automatic (follows the system); Open Sans font bundled

### Export

- Self-contained **HTML**: active theme, local images, Mermaid diagrams and formulas (SVG) embedded, raw HTML from the source dropped
- **PDF** generated in-process with Typst, with no browser and no print dialog:
  - A4 or Letter, configurable margin
  - three-field header and footer with the placeholders `{title}` `{date}` `{page}` `{pages}`
  - global defaults (File > Default PDF settings), which can be overridden for a single document at export time without touching the defaults
  - highlighted code blocks, tables, lists, quotes, alerts, footnotes, images with scale and caption, vector Mermaid diagrams and formulas
- **Print** with the system dialog (Ctrl+P)

## Shortcuts

On macOS use Cmd instead of Ctrl.

- Ctrl+N: new document
- Ctrl+O: open file
- Ctrl+Shift+O: open folder
- Ctrl+S: save
- Ctrl+Shift+S: save as
- Ctrl+Shift+E: export as PDF
- Ctrl+P: print
- Ctrl+Shift+I: insert image
- Ctrl+/: source mode
- Ctrl+Shift+L: show or hide the sidebar
- Ctrl + mouse wheel, Ctrl+`+`, Ctrl+`-`: zoom the text; Ctrl+0: reset
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

Built packages are kept in `releases/` (ignored by git). Linux package, with a dry run by default (`--apply` to execute):

```
scripts/build-linux.sh --apply
```

Windows installer and standalone exe, built on a Windows VM over SSH (dry run by default, `--apply` to execute; `--portable` also brings back the standalone `s-nib.exe`, which needs only the WebView2 runtime included in Windows 11). On the VM, `scripts/windows-build.ps1` installs Node.js, Rust and the Visual Studio Build Tools if they are missing (administrator account needed; `--no-install` only checks) and then builds. The Windows build uses the static C runtime (`src-tauri/.cargo/config.toml`):

```
SNIB_VM_USER=<user> scripts/build-windows.sh --apply --portable
```

Both scripts also write `SHA256SUMS` in `releases/`, copy the files to the web downloads folder (`SNIB_DOWNLOADS`, empty to skip) and update the `SHA256SUMS` there; replaced files go to `releases/.backup-<timestamp>/downloads/` (`scripts/publish-lib.sh`).

See the header of each script for the other options (host, folder, bundles, output).

The first build is long (Typst and Tauri). In development the Typst crates are optimized even in debug builds.

## Data and configuration

- The default PDF settings live in `pdf-settings.json` in the app configuration folder (Linux: `~/.config/ch.ssigno.s-nib/`)
- Theme, sidebar width and recent folders live in the webview data
- Pasted images go in `assets/` next to the document, with cleaned names and without overwriting existing files

## Project structure

- `src/main.ts`: editor, actions, files, themes
- `src/sidebar.ts`: file tree, recent folders, outline, resizing
- `src/editor-plugins.ts`: inline syntax, focus and typewriter modes
- `src/math-plugin.ts`: formulas in the editor (nodes, KaTeX rendering, in-place editing)
- `src/math.ts`, `src/mathjax-render.ts`: formulas as SVG for the export (MathJax loaded on export only)
- `src/mermaid.ts`: Mermaid diagrams (preview and export)
- `src/images.ts`: local images (blobs from Rust), paste and drop, insertion
- `src/export.ts`, `src/export.css`: HTML export and print
- `src/pdf-export.ts`, `src/toast.ts`: PDF dialog and messages
- `src/about.ts`: About dialog (version, license text loaded on demand)
- `src/themes.css`, `src/theme.css`, `src/styles.css`: themes, document, layout
- `src-tauri/src/lib.rs`: Rust commands (files, folders, images, HTML rendering, settings) and native menu
- `src-tauri/src/pdf.rs`: Markdown (comrak) to Typst source and PDF compilation
- `src-tauri/fonts/`: Open Sans (OFL) for the PDF
- `src-tauri/linux/s-nib.desktop`: custom desktop entry for the `.deb` (MIME types and `%F`, so file managers offer s-nib for Markdown)
- `scripts/build-linux.sh`: Debian package build, copied to `releases/`
- `scripts/publish-lib.sh`: SHA256SUMS and copy to the downloads folder, shared by the build scripts
- `scripts/build-windows.sh`, `scripts/windows-build.ps1`: Windows installer and standalone exe built on a VM over SSH, with automatic installation of the missing prerequisites
- `assets/icon.svg`: icon source (orange nib on a slate background); to regenerate the sizes: `inkscape assets/icon.svg -o assets/icon.png -w 1024 -h 1024 && npx tauri icon assets/icon.png`, then delete the `android/` and `ios/` folders created in `src-tauri/icons/`

## Known limitations

- In the exported HTML, code blocks are not highlighted and the image scale is not applied
- The PDF has its own style, not identical to the editor theme, and uses embedded fonts only: characters outside Open Sans, Libertinus and DejaVu may be missing
- Raw HTML and remote images are not included in the PDF
- Mermaid diagrams are rendered with the light theme and SVG labels; complex diagrams or invalid syntax stay as a code block in the export
- Formulas are shown with KaTeX in the editor and rendered with MathJax in the export: small differences in appearance, and a formula with invalid LaTeX stays as text in the export
- Images require an already saved document (a folder is needed to create `assets/`)
- Focus and typewriter modes exist in the code but are hidden from the interface
- On Linux, rendering depends on WebKitGTK

## Roadmap

- Polish: image scale and code highlighting in the exported HTML
- Windows installer (script ready, first run pending) and macOS build (needs a Mac or CI)
- Automated builds for all platforms (CI)
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

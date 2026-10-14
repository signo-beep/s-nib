# s-nib

Editor Markdown WYSIWYG open source (MIT) in stile Typora, per Linux, Windows e macOS.

Stack: Tauri 2 (Rust) + Vite/TypeScript + Milkdown.

## Funzioni

- Editing WYSIWYG con sintassi inline visibile sotto il cursore
- Blocchi di codice con evidenziazione della sintassi e selettore del linguaggio
- Albero cartelle con cartelle recenti, struttura del documento, barra laterale ridimensionabile
- Immagini nell'editor: percorsi relativi al documento, incolla e trascina (salvate in `assets/` accanto al `.md`), Inserisci > Immagine... (Ctrl+Shift+I); il documento va salvato prima
- Modalità sorgente (Ctrl+/)
- Temi: GitHub, Newsprint, Night, Slate, Automatico
- Export HTML autonomo (tema attivo, immagini locali incorporate)
- Export PDF integrato (Typst, senza browser né dialogo di stampa): A4 o Letter, margine, intestazione e piè di pagina a tre campi con segnaposto `{title}` `{date}` `{page}` `{pages}` (Ctrl+Shift+E). Il dialogo di export parte dai valori predefiniti e permette modifiche solo per il documento corrente (ricordate nella sessione, senza toccare i predefiniti). I valori predefiniti sono globali, salvate in `pdf-settings.json` nella cartella di configurazione dell'app (Linux: `~/.config/ch.ssigno.s-nib/`) e modificabili da File > Impostazioni PDF predefinite
- Stampa di sistema (Ctrl+P)

## Sviluppo

Prerequisiti: Node.js, Rust (rustup) e le dipendenze Tauri per il proprio sistema
(Linux: `libwebkit2gtk-4.1-dev`, `libxdo-dev`, `libssl-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`).

```
npm install
npm run tauri dev      # avvio in sviluppo
npm run build          # solo frontend
cargo test             # test Rust, da src-tauri/
npm run tauri build    # pacchetti
```

## Struttura

- `src/main.ts`: editor, azioni, file, temi
- `src/sidebar.ts`: albero file, recenti, struttura, ridimensionamento
- `src/editor-plugins.ts`: sintassi inline, focus, typewriter
- `src/images.ts`: caricamento immagini locali (blob da Rust), incolla/trascina, inserimento
- `src/export.ts`, `src/export.css`: export HTML e stampa
- `src/pdf-export.ts`, `src/toast.ts`: dialogo opzioni PDF e messaggi
- `src/themes.css`, `src/theme.css`, `src/styles.css`: temi, documento, layout
- `src-tauri/src/lib.rs`: comandi Rust (file, cartelle, render HTML, stampa) e menu nativo
- `src-tauri/src/pdf.rs`: Markdown (comrak) in sorgente Typst, compilazione in PDF; font Open Sans (OFL) in `src-tauri/fonts/`

## Limiti noti

- Nell'HTML esportato i blocchi di codice non sono evidenziati.
- Il PDF non include HTML grezzo, formule e diagrammi; le immagini remote non sono scaricate (solo locali relative).
- Il PDF usa uno stile proprio (non identico al tema dell'editor) e solo font incorporati: caratteri fuori da Open Sans, Libertinus e DejaVu possono mancare.
- Modalità focus e typewriter presenti nel codice ma nascoste dall'interfaccia.

## Licenza

MIT

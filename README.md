# s-nib

Editor Markdown WYSIWYG open source per Linux, Windows e macOS, in stile Typora.

Si scrive direttamente il documento formattato: i titoli sono titoli, il grassetto è grassetto, e la sintassi Markdown compare solo sotto il cursore. Il file resta Markdown puro, leggibile da qualsiasi altro strumento.

Il nome gioca su *signo* e *nib* (il pennino).

Stato: in sviluppo, usato finora su Linux. Windows e macOS non sono ancora stati provati.

## Funzioni

### Editing

- Editor WYSIWYG (Milkdown/ProseMirror) con CommonMark e GFM: tabelle, task list, barrato, note a piè di pagina
- Sintassi inline visibile sotto il cursore (`**`, `*`, `` ` ``, `~~`, `[testo](url)`, `#` dei titoli)
- Blocchi di codice con evidenziazione della sintassi (CodeMirror), selettore del linguaggio e pulsante Copia
- Diagrammi Mermaid: blocco di codice con linguaggio `mermaid` e anteprima sotto il codice (etichette SVG, tema chiaro)
- Immagini: visualizzazione di percorsi relativi, incolla e trascina (salvate in `assets/` accanto al `.md`), Inserisci > Immagine..., ridimensionamento e didascalia
- Modalità sorgente (Ctrl+/) per modificare il Markdown grezzo
- Annulla e ripristina illimitati

### Navigazione e interfaccia

- Barra laterale ridimensionabile con albero cartelle (7 cartelle recenti) e struttura del documento
- Barra degli strumenti e menu nativo
- Temi: GitHub, Newsprint, Night, Slate, Automatico (segue il sistema); font Open Sans incorporato

### Export

- **HTML** autonomo: tema attivo, immagini locali e diagrammi Mermaid (SVG) incorporati, HTML grezzo del sorgente escluso
- **PDF** generato in processo con Typst, senza browser né dialogo di stampa:
  - A4 o Letter, margine configurabile
  - intestazione e piè di pagina a tre campi con segnaposto `{title}` `{date}` `{page}` `{pages}`
  - impostazioni predefinite globali (File > Impostazioni PDF predefinite), modificabili per il singolo documento al momento dell'export senza toccare i predefiniti
  - blocchi di codice evidenziati, tabelle, elenchi, citazioni, note, immagini con scala e didascalia, diagrammi Mermaid vettoriali
- **Stampa** con il dialogo di sistema (Ctrl+P)

## Scorciatoie

Su macOS usare Cmd al posto di Ctrl.

- Ctrl+N: nuovo documento
- Ctrl+O: apri file
- Ctrl+Shift+O: apri cartella
- Ctrl+S: salva
- Ctrl+Shift+S: salva con nome
- Ctrl+Shift+E: esporta come PDF
- Ctrl+P: stampa
- Ctrl+Shift+I: inserisci immagine
- Ctrl+/: modalità sorgente
- Ctrl+Shift+L: mostra o nascondi la barra laterale
- Ctrl+Q: esci

## Installazione e sviluppo

Prerequisiti: Node.js, Rust (rustup) e le dipendenze di Tauri 2 per il proprio sistema
(vedere https://tauri.app/start/prerequisites/). Su Debian e Ubuntu:

```
sudo apt install build-essential libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev
```

Comandi:

```
npm install
npm run tauri dev      # avvio in sviluppo
npm run build          # solo frontend (controllo dei tipi e bundle)
npm run tauri build    # pacchetti per il sistema corrente
cd src-tauri && cargo test    # test Rust
```

La prima compilazione è lunga (Typst e Tauri). In sviluppo i crate di Typst sono ottimizzati anche in debug.

## Dati e configurazione

- Le impostazioni PDF predefinite stanno in `pdf-settings.json` nella cartella di configurazione dell'app (Linux: `~/.config/ch.ssigno.s-nib/`)
- Tema, larghezza della barra laterale e cartelle recenti stanno nei dati del webview
- Le immagini incollate vanno in `assets/` accanto al documento, con nomi ripuliti e senza sovrascrivere file esistenti

## Struttura del progetto

- `src/main.ts`: editor, azioni, file, temi
- `src/sidebar.ts`: albero file, cartelle recenti, struttura, ridimensionamento
- `src/editor-plugins.ts`: sintassi inline, modalità focus e typewriter
- `src/images.ts`: immagini locali (blob da Rust), incolla e trascina, inserimento
- `src/export.ts`, `src/export.css`: export HTML e stampa
- `src/pdf-export.ts`, `src/toast.ts`: dialogo del PDF e messaggi
- `src/themes.css`, `src/theme.css`, `src/styles.css`: temi, documento, layout
- `src-tauri/src/lib.rs`: comandi Rust (file, cartelle, immagini, render HTML, impostazioni) e menu nativo
- `src-tauri/src/pdf.rs`: Markdown (comrak) in sorgente Typst e compilazione in PDF
- `src-tauri/fonts/`: Open Sans (OFL) per il PDF

## Limiti noti

- Nell'HTML esportato i blocchi di codice non sono evidenziati e la scala delle immagini non è applicata
- Il PDF ha uno stile proprio, non identico al tema dell'editor, e usa solo font incorporati: caratteri fuori da Open Sans, Libertinus e DejaVu possono mancare
- HTML grezzo, formule e immagini remote non sono inclusi nel PDF
- I diagrammi Mermaid sono resi con il tema chiaro e le etichette in SVG; diagrammi complessi o con sintassi non valida restano come blocco di codice nell'export
- Le immagini richiedono un documento già salvato (serve la cartella in cui creare `assets/`)
- Le modalità focus e typewriter sono presenti nel codice ma nascoste dall'interfaccia
- Su Linux il rendering dipende da WebKitGTK

## Roadmap

- Formule matematiche
- Ritocchi: scala delle immagini e evidenziazione del codice nell'HTML esportato
- Pacchetti per Linux, Windows e macOS
- Eventuale export DOCX e altri formati

## Licenza

Il progetto è distribuito con licenza MIT (vedere `LICENSE`).

Componenti di terze parti, tutti con licenze compatibili:

- Tauri: MIT o Apache-2.0
- Mermaid: MIT
- Milkdown e ProseMirror: MIT
- CodeMirror: MIT
- Typst: Apache-2.0
- comrak: BSD-2-Clause
- Open Sans (incorporato in `src-tauri/fonts/` e tramite `@fontsource`): SIL Open Font License 1.1 (testo in `src-tauri/fonts/OFL.txt`)

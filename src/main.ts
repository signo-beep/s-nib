import "@fontsource/open-sans/400.css";
import "@fontsource/open-sans/400-italic.css";
import "@fontsource/open-sans/600.css";
import "@fontsource/open-sans/700.css";
import "@fontsource/open-sans/700-italic.css";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, schemaCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { codeBlockComponent, codeBlockConfig } from "@milkdown/kit/component/code-block";
import { imageBlockComponent, imageBlockConfig } from "@milkdown/kit/component/image-block";
import { imageInlineComponent, inlineImageConfig } from "@milkdown/kit/component/image-inline";
import { trailing } from "@milkdown/kit/plugin/trailing";
import { upload, uploadConfig } from "@milkdown/kit/plugin/upload";
import { listItemBlockComponent, listItemBlockConfig } from "@milkdown/kit/component/list-item-block";
import { getMarkdown, replaceAll } from "@milkdown/kit/utils";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, LanguageDescription, LanguageSupport, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { editingExperience, gapCursorPlugin } from "./editor-plugins";
import { escapeHtml, isMermaidLanguage, renderMermaid } from "./mermaid";
import { exportHtml, printDocument } from "./export";
import { clearImageCache, imageNode, initImages, pickImage, proxyImageUrl, uploadImageFile, uploadImages } from "./images";
import { editPdfSettings, exportPdf } from "./pdf-export";
import { showToast } from "./toast";
import { initSidebar, openFolder, setActiveFile, toggleSidebar, updateOutline } from "./sidebar";

const MD_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }];

const editorEl = document.getElementById("editor")!;
const sourceEl = document.getElementById("source") as HTMLTextAreaElement;
const toolbarEl = document.getElementById("toolbar")!;
const themeButton = document.getElementById("theme-button")!;
const themeList = document.getElementById("theme-list")!;

let currentPath: string | null = null;
let savedMarkdown = "";
let dirty = false;
let sourceMode = false;

/** Voce "Mermaid" nel selettore dei linguaggi: testo semplice, l'anteprima è nel blocco. */
const mermaidLanguage = LanguageDescription.of({
  name: "Mermaid",
  alias: ["mermaid"],
  load: async () =>
    new LanguageSupport(
      StreamLanguage.define({
        token: (stream) => {
          stream.skipToEnd();
          return null;
        },
      }),
    ),
});

const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword], color: "var(--hl-keyword)" },
  { tag: [t.string, t.regexp, t.special(t.string)], color: "var(--hl-string)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--hl-comment)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--hl-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName)], color: "var(--hl-fn)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--hl-type)" },
  { tag: [t.propertyName, t.attributeName, t.tagName], color: "var(--hl-prop)" },
  { tag: [t.operator, t.punctuation], color: "var(--hl-op)" },
]);

initImages(() => currentPath);
initSidebar({ onOpenFile: (path) => void openPath(path) });

const editor = await Editor.make()
  .config((ctx) => {
    ctx.set(rootCtx, editorEl);
    ctx.set(defaultValueCtx, "");
    ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
      setDirty(markdown !== savedMarkdown);
      updateOutline();
    });
    ctx.update(codeBlockConfig.key, (config) => ({
      ...config,
      languages: [...languages, mermaidLanguage],
      previewLabel: "Anteprima",
      previewLoading: "Rendering del diagramma...",
      previewToggleButton: (previewOnly: boolean) => (previewOnly ? "Modifica" : "Nascondi"),
      renderPreview: (language: string, content: string, applyPreview: (value: string | null) => void) => {
        if (!isMermaidLanguage(language) || !content.trim()) return null;
        renderMermaid(content)
          .then((svg) => applyPreview(`<div class="mermaid-diagram">${svg}</div>`))
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            applyPreview(`<div class="mermaid-error">${escapeHtml(message)}</div>`);
          });
        return undefined;
      },
      extensions: [syntaxHighlighting(highlightStyle), EditorView.lineWrapping],
      expandIcon: "▾",
      searchIcon: "",
      clearSearchIcon: "✕",
      copyIcon: "",
      copyText: "Copia",
      searchPlaceholder: "Cerca linguaggio",
      noResultText: "Nessun risultato",
    }));
    const imageTexts = {
      uploadButton: "Carica immagine",
      confirmButton: "OK",
      uploadPlaceholderText: "oppure incolla un URL o un percorso",
    };
    ctx.update(imageBlockConfig.key, (config) => ({
      ...config,
      ...imageTexts,
      captionPlaceholderText: "Didascalia",
      imageIcon: "\u25A3",
      captionIcon: "Aa",
      onUpload: uploadImageFile,
      proxyDomURL: proxyImageUrl,
    }));
    ctx.update(inlineImageConfig.key, (config) => ({
      ...config,
      ...imageTexts,
      imageIcon: "\u25A3",
      onUpload: uploadImageFile,
      proxyDomURL: proxyImageUrl,
    }));
    ctx.update(uploadConfig.key, (config) => ({ ...config, uploader: uploadImages }));
    ctx.update(listItemBlockConfig.key, (config) => ({
      ...config,
      renderLabel: ({ label, listType, checked }) => {
        if (checked == null) return listType === "bullet" ? "•" : label;
        return checked ? "☑" : "☐";
      },
    }));
  })
  .use(commonmark)
  .use(gfm)
  .use(history)
  .use(listener)
  .use(codeBlockComponent)
  .use(listItemBlockComponent)
  .use(imageBlockComponent)
  .use(imageInlineComponent)
  .use(upload)
  .use(editingExperience)
  .use(gapCursorPlugin)
  .use(trailing)
  .create();

const currentMarkdown = () => editor.action(getMarkdown());
const getContent = () => (sourceMode ? sourceEl.value : currentMarkdown());

function fileName(): string {
  return currentPath ? (currentPath.split(/[\\/]/).pop() ?? currentPath) : "Senza titolo";
}

function updateTitle() {
  const title = `${dirty ? "● " : ""}${fileName()} | s-nib`;
  document.title = title;
  void getCurrentWindow().setTitle(title);
}

function setDirty(value: boolean) {
  if (dirty === value) return;
  dirty = value;
  updateTitle();
}

function setSourceMode(on: boolean) {
  if (on === sourceMode) return;
  if (on) {
    sourceEl.value = currentMarkdown();
  } else {
    editor.action(replaceAll(sourceEl.value));
  }
  sourceMode = on;
  editorEl.hidden = on;
  sourceEl.hidden = !on;
  if (on) sourceEl.focus();
  else updateOutline();
}

function toggleBodyMode(name: string) {
  document.body.classList.toggle(name);
}

function syncThemePicker(name: string) {
  themeList.querySelectorAll<HTMLButtonElement>("[data-theme-value]").forEach((option) => {
    const selected = option.dataset.themeValue === name;
    option.classList.toggle("current", selected);
    option.setAttribute("aria-selected", String(selected));
    if (selected) themeButton.textContent = option.textContent;
  });
}

function closeThemeList() {
  themeList.hidden = true;
  themeButton.setAttribute("aria-expanded", "false");
}

function setTheme(name: string) {
  const root = document.documentElement;
  if (name === "auto") delete root.dataset.theme;
  else root.dataset.theme = name;
  syncThemePicker(name);
  try {
    localStorage.setItem("theme", name);
  } catch {
    // storage non disponibile: il tema resta valido per la sessione
  }
}

function loadContent(path: string | null, content: string) {
  setSourceMode(false);
  clearImageCache();
  currentPath = path;
  editor.action(replaceAll(content));
  savedMarkdown = currentMarkdown();
  dirty = false;
  updateTitle();
  updateOutline();
  setActiveFile(path);
  syncToolbar();
}

async function confirmDiscard(): Promise<boolean> {
  if (!dirty) return true;
  return ask("Ci sono modifiche non salvate. Scartarle?", {
    title: "s-nib",
    kind: "warning",
    okLabel: "Scarta",
    cancelLabel: "Annulla",
  });
}

async function newFile() {
  if (!(await confirmDiscard())) return;
  loadContent(null, "");
}

async function openFile() {
  if (!(await confirmDiscard())) return;
  const path = await open({ multiple: false, directory: false, filters: MD_FILTERS });
  if (typeof path !== "string") return;
  await loadPath(path);
}

async function loadPath(path: string) {
  const content = await invoke<string>("read_text_file", { path });
  loadContent(path, content);
}

async function openPath(path: string) {
  if (path === currentPath || !(await confirmDiscard())) return;
  await loadPath(path);
}

async function saveFile(forceDialog = false): Promise<boolean> {
  let path = currentPath;
  if (!path || forceDialog) {
    path = await save({ filters: MD_FILTERS, defaultPath: currentPath ?? "senza-titolo.md" });
    if (!path) return false;
  }
  const content = getContent();
  await invoke("write_text_file", { path, content });
  currentPath = path;
  savedMarkdown = content;
  dirty = false;
  updateTitle();
  setActiveFile(path);
  return true;
}

async function insertImage() {
  if (sourceMode) setSourceMode(false);
  const src = await pickImage();
  if (!src) return;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const node = imageNode(ctx.get(schemaCtx), src);
    if (!node) return;
    view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
    view.focus();
  });
}

const MENU_ACTIONS: Record<string, () => void | Promise<unknown>> = {
  new: newFile,
  open: openFile,
  open_folder: openFolder,
  save: () => saveFile(false),
  save_as: () => saveFile(true),
  insert_image: insertImage,
  export_html: () => exportHtml(getContent(), currentPath),
  export_pdf: () => exportPdf(getContent(), currentPath),
  pdf_settings: () => editPdfSettings(),
  print: () => {
    setSourceMode(false);
    return printDocument();
  },
  quit: () => getCurrentWindow().close(),
  toggle_sidebar: toggleSidebar,
  source: () => setSourceMode(!sourceMode),
  focus: () => toggleBodyMode("focus-mode"),
  typewriter: () => toggleBodyMode("typewriter"),
  theme_auto: () => setTheme("auto"),
  theme_github: () => setTheme("github"),
  theme_newsprint: () => setTheme("newsprint"),
  theme_night: () => setTheme("night"),
  theme_slate: () => setTheme("slate"),
};

function syncToolbar() {
  const state: Record<string, boolean> = {
    source: sourceMode,
    focus: document.body.classList.contains("focus-mode"),
    typewriter: document.body.classList.contains("typewriter"),
    toggle_sidebar: !document.getElementById("app")!.classList.contains("no-sidebar"),
  };
  toolbarEl.querySelectorAll<HTMLButtonElement>("[data-action]").forEach((button) => {
    const action = button.dataset.action ?? "";
    if (!(action in state)) return;
    button.classList.toggle("active", state[action]);
    button.setAttribute("aria-pressed", String(state[action]));
  });
}

async function runAction(name: string) {
  try {
    await MENU_ACTIONS[name]?.();
  } catch (error) {
    showToast(String(error), "error");
  }
  syncToolbar();
}

await listen<string>("menu", (event) => {
  void runAction(event.payload);
});

toolbarEl.addEventListener("mousedown", (event) => {
  // evita che i pulsanti tolgano il focus all'editor
  if ((event.target as Element).closest("button")) event.preventDefault();
});
toolbarEl.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLElement>("[data-action]");
  if (button?.dataset.action) void runAction(button.dataset.action);
});
themeButton.addEventListener("click", () => {
  const opening = themeList.hidden;
  themeList.hidden = !opening;
  themeButton.setAttribute("aria-expanded", String(opening));
});
themeList.addEventListener("click", (event) => {
  const option = (event.target as Element).closest<HTMLElement>("[data-theme-value]");
  if (!option?.dataset.themeValue) return;
  setTheme(option.dataset.themeValue);
  closeThemeList();
});
document.addEventListener("pointerdown", (event) => {
  if (!themeList.hidden && !(event.target as Element).closest("#theme-picker")) closeThemeList();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !themeList.hidden) closeThemeList();
});

sourceEl.addEventListener("input", () => setDirty(sourceEl.value !== savedMarkdown));

void getCurrentWindow().onCloseRequested(async (event) => {
  if (!(await confirmDiscard())) event.preventDefault();
});

try {
  setTheme(localStorage.getItem("theme") ?? "auto");
} catch {
  // storage non disponibile: tema automatico
}

updateTitle();
syncToolbar();

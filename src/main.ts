import "@fontsource/open-sans/400.css";
import "@fontsource/open-sans/400-italic.css";
import "@fontsource/open-sans/600.css";
import "@fontsource/open-sans/700.css";
import "@fontsource/open-sans/700-italic.css";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, schemaCtx } from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm, insertTableCommand } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { codeBlockComponent, codeBlockConfig } from "@milkdown/kit/component/code-block";
import { imageBlockComponent, imageBlockConfig } from "@milkdown/kit/component/image-block";
import { imageInlineComponent, inlineImageConfig } from "@milkdown/kit/component/image-inline";
import { trailing } from "@milkdown/kit/plugin/trailing";
import { upload, uploadConfig } from "@milkdown/kit/plugin/upload";
import { listItemBlockComponent, listItemBlockConfig } from "@milkdown/kit/component/list-item-block";
import { callCommand, getMarkdown, replaceAll } from "@milkdown/kit/utils";
import { languages } from "@codemirror/language-data";
import { HighlightStyle, LanguageDescription, LanguageSupport, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { showAbout } from "./about";
import { alertBlockquote } from "./alerts";
import { initContextMenu } from "./context-menu";
import { editingExperience, gapCursorPlugin } from "./editor-plugins";
import { mathPlugin } from "./math-plugin";
import { escapeHtml, isMermaidLanguage, renderMermaid } from "./mermaid";
import { exportHtml, printDocument } from "./export";
import { clearImageCache, imageNode, initImages, pickImage, proxyImageUrl, uploadImageFile, uploadImages } from "./images";
import { editPdfSettings, exportPdf } from "./pdf-export";
import { initSearch, searchPlugin } from "./search";
import { showToast } from "./toast";
import { initSidebar, openFolder, setActiveFile, toggleSidebar, updateOutline } from "./sidebar";
import { initTabs } from "./tabs";

const MD_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }];

const editorEl = document.getElementById("editor")!;
const sourceEl = document.getElementById("source") as HTMLTextAreaElement;
const toolbarEl = document.getElementById("toolbar")!;
const scrollerEl = document.getElementById("scroller")!;
const themeButton = document.getElementById("theme-button")!;
const themeList = document.getElementById("theme-list")!;

let currentPath: string | null = null;
let savedMarkdown = "";
let dirty = false;
let sourceMode = false;
let knownMtime: number | null = null;
let externalChange: number | null | undefined;

/** One open document. The active tab lives in the editor and in the variables above: its entry here is refreshed by `captureActive`. */
interface Tab {
  path: string | null;
  content: string;
  savedMarkdown: string;
  dirty: boolean;
  sourceMode: boolean;
  knownMtime: number | null;
  scrollTop: number;
}

const blankTab = (): Tab => ({ path: null, content: "", savedMarkdown: "", dirty: false, sourceMode: false, knownMtime: null, scrollTop: 0 });
let tabs: Tab[] = [blankTab()];
let activeIndex = 0;

const AUTOSAVE_DELAY = 2000;
const SESSION_DELAY = 1000;
let autosaveOn = true;
let autosaveTimer: number | undefined;
let sessionTimer: number | undefined;

/** "Mermaid" entry in the language picker: plain text, the preview lives in the block. */
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
      scheduleAutosave();
      scheduleSession();
    });
    ctx.update(codeBlockConfig.key, (config) => ({
      ...config,
      languages: [...languages, mermaidLanguage],
      previewLabel: "Preview",
      previewLoading: "Rendering diagram...",
      previewToggleButton: (previewOnly: boolean) => (previewOnly ? "Edit" : "Hide"),
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
      extensions: [syntaxHighlighting(highlightStyle), EditorView.lineWrapping, EditorView.contentAttributes.of({ spellcheck: "false" })],
      expandIcon: "▾",
      searchIcon: "",
      clearSearchIcon: "✕",
      copyIcon: "",
      copyText: "Copy",
      searchPlaceholder: "Search language",
      noResultText: "No results",
    }));
    const imageTexts = {
      uploadButton: "Upload image",
      confirmButton: "OK",
      uploadPlaceholderText: "or paste a URL or a path",
    };
    ctx.update(imageBlockConfig.key, (config) => ({
      ...config,
      ...imageTexts,
      captionPlaceholderText: "Caption",
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
  .use(alertBlockquote)
  .use(history)
  .use(listener)
  .use(codeBlockComponent)
  .use(listItemBlockComponent)
  .use(imageBlockComponent)
  .use(imageInlineComponent)
  .use(upload)
  .use(editingExperience)
  .use(gapCursorPlugin)
  .use(mathPlugin)
  .use(searchPlugin)
  .use(trailing)
  .create();

const renderTabs = initTabs({
  onSelect: (index) => void switchTo(index).catch((error) => showToast(String(error), "error")),
  onClose: (index) => void closeTab(index).catch((error) => showToast(String(error), "error")),
  onNew: () => void runAction("new"),
});

initContextMenu(editor, editorEl);
const refreshSearch = initSearch(editor, sourceEl, () => sourceMode);

const currentMarkdown = () => editor.action(getMarkdown());
const getContent = () => (sourceMode ? sourceEl.value : currentMarkdown());

function baseName(path: string | null): string {
  return path ? (path.split(/[\\/]/).pop() ?? path) : "Untitled";
}

function fileName(): string {
  return baseName(currentPath);
}

function updateTitle() {
  const title = `${dirty ? "● " : ""}${fileName()} | s-nib`;
  document.title = title;
  void getCurrentWindow().setTitle(title);
  renderTabs(
    tabs.map((tab, index) => (index === activeIndex ? { title: fileName(), dirty } : { title: baseName(tab.path), dirty: tab.dirty })),
    activeIndex,
  );
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
  refreshSearch();
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
    // storage unavailable: the theme stays valid for the session
  }
}

function loadContent(path: string | null, content: string) {
  setSourceMode(false);
  clearImageCache();
  currentPath = path;
  knownMtime = null;
  hideChangeBar();
  editor.action(replaceAll(content, true));
  savedMarkdown = currentMarkdown();
  dirty = false;
  updateTitle();
  updateOutline();
  setActiveFile(path);
  syncToolbar();
}

function discardPrompt(message: string): Promise<boolean> {
  return ask(message, { title: "s-nib", kind: "warning", okLabel: "Discard", cancelLabel: "Cancel" });
}

/** Store the live state of the active tab in `tabs`. */
function captureActive() {
  tabs[activeIndex] = {
    path: currentPath,
    content: getContent(),
    savedMarkdown,
    dirty,
    sourceMode,
    knownMtime,
    scrollTop: scrollerEl.scrollTop,
  };
}

/** Load a stored tab into the editor, undo history included. */
function restoreTab(tab: Tab) {
  setSourceMode(false);
  clearImageCache();
  currentPath = tab.path;
  knownMtime = tab.knownMtime;
  hideChangeBar();
  editor.action(replaceAll(tab.content, true));
  // a clean tab is compared with its own re-serialized text, so it does not look modified
  savedMarkdown = tab.dirty ? tab.savedMarkdown : currentMarkdown();
  dirty = tab.dirty;
  if (tab.sourceMode) {
    setSourceMode(true);
    sourceEl.value = tab.content;
  }
  updateTitle();
  updateOutline();
  setActiveFile(tab.path);
  syncToolbar();
  scrollerEl.scrollTop = tab.scrollTop;
}

/** An untouched "Untitled" tab is reused instead of opening a new one. */
function isPristine() {
  return !currentPath && !dirty && !sourceMode && tabs.length === 1;
}

/** Make room for a new document: a new tab, unless the active one is untouched. */
async function prepareNewTab() {
  if (isPristine()) return;
  await autosaveNow();
  captureActive();
  tabs.push(blankTab());
  activeIndex = tabs.length - 1;
}

async function switchTo(index: number) {
  if (index === activeIndex || index < 0 || index >= tabs.length) return;
  await autosaveNow();
  captureActive();
  activeIndex = index;
  restoreTab(tabs[index]);
  void checkExternalChange();
  scheduleSession();
}

function cycleTab(step: number) {
  if (tabs.length > 1) void switchTo((activeIndex + step + tabs.length) % tabs.length);
}

async function closeTab(index = activeIndex) {
  if (index === activeIndex) await autosaveNow();
  captureActive();
  const tab = tabs[index];
  if (tab.dirty && !(await discardPrompt(`${baseName(tab.path)} has unsaved changes. Discard them?`))) return;
  if (tabs.length === 1) {
    tabs[0] = blankTab();
    restoreTab(tabs[0]);
  } else {
    tabs.splice(index, 1);
    if (index === activeIndex) {
      activeIndex = Math.min(index, tabs.length - 1);
      restoreTab(tabs[activeIndex]);
      void checkExternalChange();
    } else {
      if (index < activeIndex) activeIndex--;
      updateTitle();
    }
  }
  scheduleSession();
}

async function newFile() {
  if (isPristine()) return;
  await prepareNewTab();
  loadContent(null, "");
}

async function openFile() {
  const path = await open({ multiple: false, directory: false, filters: MD_FILTERS });
  if (typeof path !== "string") return;
  await openPath(path);
}

/** Read the active file again from disk (external change bar). */
async function reloadActive() {
  if (!currentPath) return;
  loadContent(currentPath, await invoke<string>("read_text_file", { path: currentPath }));
  await syncMtime();
}

const changeBar = document.getElementById("external-change")!;
const changeText = document.getElementById("external-change-text")!;

function hideChangeBar() {
  changeBar.hidden = true;
  externalChange = undefined;
}

async function syncMtime() {
  hideChangeBar();
  knownMtime = currentPath ? await invoke<number | null>("file_mtime", { path: currentPath }) : null;
}

/** Compare the file on disk with the version loaded or saved here. */
async function checkExternalChange() {
  if (!currentPath || knownMtime === null) return;
  let mtime: number | null;
  try {
    mtime = await invoke<number | null>("file_mtime", { path: currentPath });
  } catch {
    return;
  }
  if (mtime === knownMtime || mtime === externalChange) return;
  externalChange = mtime;
  const unsaved = dirty ? " Reloading discards your unsaved changes." : "";
  changeText.textContent = mtime === null
    ? `${fileName()} was deleted or moved outside s-nib.`
    : `${fileName()} was changed outside s-nib.${unsaved}`;
  (document.getElementById("external-change-reload") as HTMLButtonElement).hidden = mtime === null;
  changeBar.hidden = false;
}

document.getElementById("external-change-reload")!.addEventListener("click", () => {
  void reloadActive().catch((error) => showToast(String(error), "error"));
});
document.getElementById("external-change-ignore")!.addEventListener("click", () => {
  // keep the new state as the baseline: the bar returns only on a further change
  knownMtime = externalChange ?? knownMtime;
  if (externalChange === null) knownMtime = null;
  hideChangeBar();
});

void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
  if (focused) void checkExternalChange();
});
window.setInterval(() => {
  if (document.hasFocus()) void checkExternalChange();
}, 2000);

async function openPath(path: string) {
  if (path === currentPath) return;
  captureActive();
  const existing = tabs.findIndex((tab) => tab.path === path);
  if (existing >= 0) {
    await switchTo(existing);
    return;
  }
  const content = await invoke<string>("read_text_file", { path });
  await prepareNewTab();
  loadContent(path, content);
  await syncMtime();
}

/** Save the active file by itself after a pause in typing, unless the file changed on disk meanwhile. */
async function autosaveNow() {
  window.clearTimeout(autosaveTimer);
  if (!autosaveOn || !dirty || !currentPath || !changeBar.hidden) return;
  try {
    const mtime = await invoke<number | null>("file_mtime", { path: currentPath });
    if (mtime !== knownMtime) {
      await checkExternalChange();
      return;
    }
    await saveFile(false);
  } catch (error) {
    showToast(`Autosave failed: ${String(error)}`, "error");
  }
}

function scheduleAutosave() {
  window.clearTimeout(autosaveTimer);
  if (autosaveOn && dirty && currentPath) autosaveTimer = window.setTimeout(() => void autosaveNow(), AUTOSAVE_DELAY);
}

/** Recovery copy of the unsaved tabs: restored after a crash, removed on a clean exit. */
async function writeSession() {
  captureActive();
  const unsaved = tabs.filter((tab) => tab.dirty && (tab.path || tab.content.trim()));
  try {
    if (!unsaved.length) {
      await invoke("clear_session");
      return;
    }
    const active = Math.max(0, unsaved.indexOf(tabs[activeIndex]));
    const json = JSON.stringify({ active, tabs: unsaved.map(({ path, content }) => ({ path, content })) });
    await invoke("save_session", { json });
  } catch {
    // recovery copy is best effort
  }
}

function scheduleSession() {
  window.clearTimeout(sessionTimer);
  sessionTimer = window.setTimeout(() => void writeSession(), SESSION_DELAY);
}

async function restoreSession() {
  const raw = await invoke<string | null>("load_session");
  if (!raw) return;
  let items: { path: string | null; content: string }[] = [];
  let active = 0;
  try {
    const data = JSON.parse(raw);
    active = Number(data.active) || 0;
    items = (data.tabs as { path: unknown; content: unknown }[])
      .filter((item) => typeof item.content === "string" && (typeof item.path === "string" || item.path === null))
      .map((item) => ({ path: item.path as string | null, content: item.content as string }));
  } catch {
    // damaged file: treated as empty
  }
  if (!items.length) {
    await invoke("clear_session");
    return;
  }
  const label = items.length === 1 ? "1 unsaved document" : `${items.length} unsaved documents`;
  const recover = await ask(`Recover ${label} from the previous session?`, {
    title: "s-nib",
    kind: "info",
    okLabel: "Recover",
    cancelLabel: "Discard",
  });
  if (!recover) {
    await invoke("clear_session");
    return;
  }
  tabs = await Promise.all(
    items.map(async ({ path, content }) => {
      let onDisk = "";
      let mtime: number | null = null;
      if (path) {
        try {
          onDisk = await invoke<string>("read_text_file", { path });
          mtime = await invoke<number | null>("file_mtime", { path });
        } catch {
          // file no longer readable: the recovered text will be saved as new
        }
      }
      return { ...blankTab(), path, content, savedMarkdown: onDisk, dirty: true, knownMtime: mtime };
    }),
  );
  activeIndex = Math.min(Math.max(0, active), tabs.length - 1);
  restoreTab(tabs[activeIndex]);
}

async function saveFile(forceDialog = false): Promise<boolean> {
  let path = currentPath;
  if (!path || forceDialog) {
    path = await save({ filters: MD_FILTERS, defaultPath: currentPath ?? "untitled.md" });
    if (!path) return false;
  }
  const content = getContent();
  await invoke("write_text_file", { path, content });
  currentPath = path;
  savedMarkdown = content;
  dirty = false;
  updateTitle();
  setActiveFile(path);
  await syncMtime();
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

function askTableSize(): Promise<{ row: number; col: number } | null> {
  const dialog = document.getElementById("table-dialog") as HTMLDialogElement;
  const form = document.getElementById("table-form") as HTMLFormElement;
  const rows = document.getElementById("table-rows") as HTMLInputElement;
  const cols = document.getElementById("table-cols") as HTMLInputElement;
  const cancel = document.getElementById("table-cancel")!;
  return new Promise((resolve) => {
    const finish = (value: { row: number; col: number } | null) => {
      form.removeEventListener("submit", onSubmit);
      cancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const clamp = (input: HTMLInputElement) =>
      Math.min(Number(input.max), Math.max(1, Math.round(Number(input.value)) || 1));
    const onSubmit = (event: Event) => {
      event.preventDefault();
      finish({ row: clamp(rows), col: clamp(cols) });
    };
    const onCancel = () => finish(null);
    form.addEventListener("submit", onSubmit);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel);
    dialog.showModal();
    rows.select();
  });
}

async function insertTable() {
  if (sourceMode) setSourceMode(false);
  const size = await askTableSize();
  if (!size) return;
  editor.action(callCommand(insertTableCommand.key, size));
  editor.action((ctx) => ctx.get(editorViewCtx).focus());
}

function setAutosave(on: boolean) {
  autosaveOn = on;
  showToast(`Autosave ${on ? "on" : "off"}`);
  try {
    localStorage.setItem("autosave", String(on));
  } catch {
    // storage unavailable: setting not remembered
  }
  scheduleAutosave();
}

type SpellMode = "off" | "en" | "it" | "both";
const SPELL_LANGUAGES: Record<SpellMode, string[]> = { off: [], en: ["en_US"], it: ["it_IT"], both: ["it_IT", "en_US"] };

function setSpellcheck(mode: SpellMode) {
  editorEl.spellcheck = mode !== "off";
  editorEl.lang = mode === "it" ? "it" : "en";
  void invoke("set_spellcheck", { languages: SPELL_LANGUAGES[mode] });
  try {
    localStorage.setItem("spellcheck", mode);
  } catch {
    // storage unavailable: setting not remembered
  }
}

const MENU_ACTIONS: Record<string, () => void | Promise<unknown>> = {
  new: newFile,
  open: openFile,
  open_folder: openFolder,
  save: () => saveFile(false),
  save_as: () => saveFile(true),
  autosave: () => setAutosave(!autosaveOn),
  close_tab: () => closeTab(),
  next_tab: () => cycleTab(1),
  prev_tab: () => cycleTab(-1),
  spell_off: () => setSpellcheck("off"),
  spell_en: () => setSpellcheck("en"),
  spell_it: () => setSpellcheck("it"),
  spell_both: () => setSpellcheck("both"),
  insert_image: insertImage,
  insert_table: insertTable,
  about: showAbout,
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
  // keep the buttons from taking focus away from the editor
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

// Zoom del testo: documento e sidebar separati (Ctrl + rotella, Ctrl + / - / 0 solo documento)
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.1;
let zoom = 1;
let sidebarZoom = 1;

function clampZoom(value: number) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));
}

function setZoom(value: number) {
  zoom = clampZoom(value);
  document.documentElement.style.setProperty("--zoom", String(zoom));
  try {
    localStorage.setItem("zoom", String(zoom));
  } catch {
    // storage unavailable: zoom not remembered
  }
}

function setSidebarZoom(value: number) {
  sidebarZoom = clampZoom(value);
  document.documentElement.style.setProperty("--sidebar-zoom", String(sidebarZoom));
  try {
    localStorage.setItem("sidebar-zoom", String(sidebarZoom));
  } catch {
    // storage unavailable: zoom not remembered
  }
}

try {
  const saved = Number(localStorage.getItem("zoom"));
  if (saved) setZoom(saved);
  const savedSidebar = Number(localStorage.getItem("sidebar-zoom"));
  if (savedSidebar) setSidebarZoom(savedSidebar);
} catch {
  // storage unavailable: default zoom
}

document.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
    if ((event.target as Element).closest("#sidebar")) setSidebarZoom(sidebarZoom + delta);
    else setZoom(zoom + delta);
  },
  { passive: false },
);
document.addEventListener("keydown", (event) => {
  if (!event.ctrlKey || event.altKey) return;
  if (event.key === "+" || event.key === "=") setZoom(zoom + ZOOM_STEP);
  else if (event.key === "-") setZoom(zoom - ZOOM_STEP);
  else if (event.key === "0") setZoom(1);
  else return;
  event.preventDefault();
});

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key === "Tab") {
    event.preventDefault();
    cycleTab(event.shiftKey ? -1 : 1);
  }
});

sourceEl.addEventListener("input", () => {
  setDirty(sourceEl.value !== savedMarkdown);
  scheduleAutosave();
  scheduleSession();
});

void getCurrentWindow().onCloseRequested(async (event) => {
  await autosaveNow();
  captureActive();
  const unsaved = tabs.filter((tab) => tab.dirty).length;
  if (unsaved) {
    const message = unsaved === 1 ? "You have unsaved changes. Discard them?" : `${unsaved} documents have unsaved changes. Discard them?`;
    if (!(await discardPrompt(message))) {
      event.preventDefault();
      return;
    }
  }
  window.clearTimeout(sessionTimer);
  await invoke("clear_session").catch(() => undefined);
});

try {
  setTheme(localStorage.getItem("theme") ?? "auto");
} catch {
  // storage unavailable: automatic theme
}

try {
  autosaveOn = localStorage.getItem("autosave") !== "false";
} catch {
  // storage unavailable: autosave stays on
}
{
  let mode: SpellMode = "both";
  try {
    const saved = localStorage.getItem("spellcheck");
    if (saved && saved in SPELL_LANGUAGES) mode = saved as SpellMode;
  } catch {
    // storage unavailable: default languages
  }
  setSpellcheck(mode);
}

updateTitle();
syncToolbar();

// File passed on the command line (for example from the file manager)
await restoreSession();
const initialFile = await invoke<string | null>("initial_file");
if (initialFile) await openPath(initialFile);

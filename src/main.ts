import "@fontsource/open-sans/400.css";
import "@fontsource/open-sans/400-italic.css";
import "@fontsource/open-sans/600.css";
import "@fontsource/open-sans/700.css";
import "@fontsource/open-sans/700-italic.css";
import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  schemaCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm, insertTableCommand } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import {
  codeBlockComponent,
  codeBlockConfig,
} from "@milkdown/kit/component/code-block";
import {
  imageBlockComponent,
  imageBlockConfig,
} from "@milkdown/kit/component/image-block";
import {
  imageInlineComponent,
  inlineImageConfig,
} from "@milkdown/kit/component/image-inline";
import { trailing } from "@milkdown/kit/plugin/trailing";
import { upload, uploadConfig } from "@milkdown/kit/plugin/upload";
import {
  listItemBlockComponent,
  listItemBlockConfig,
} from "@milkdown/kit/component/list-item-block";
import type { Schema } from "@milkdown/kit/prose/model";
import { callCommand, getMarkdown, replaceAll } from "@milkdown/kit/utils";
import { languages } from "@codemirror/language-data";
import {
  HighlightStyle,
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { showAbout } from "./about";
import { alertBlockquote } from "./alerts";
import { initContextMenu } from "./context-menu";
import { initPalette } from "./palette";
import {
  compositionInlineCode,
  editingExperience,
  gapCursorPlugin,
  hideSyntaxMarkers,
} from "./editor-plugins";
import { mathPlugin } from "./math-plugin";
import { escapeHtml, isMermaidLanguage, renderMermaid } from "./mermaid";
import { openHistory } from "./history";
import { isExternalLink, resolveLocalLink } from "./links";
import { joinFrontMatter, splitFrontMatter } from "./frontmatter";
import { exportHtml, exportPandoc, printDocument } from "./export";
import {
  clearImageCache,
  imageNode,
  importImagePaths,
  pickImage,
  proxyImageUrl,
  uploadImageFile,
  uploadImages,
} from "./images";
import { editPdfSettings, exportPdf } from "./pdf-export";
import { initSearch, searchPlugin } from "./search";
import { showToast } from "./toast";
import {
  hideTerminal,
  pasteFilePaths,
  restartTerminal,
  terminalContainsPoint,
  setTerminalFolderProvider,
  showTerminal,
  splitTerminal,
  terminalFocused,
  terminalVisible,
  writeToTerminal,
  zoomTerminal,
} from "./terminal";
import {
  getCurrentFolder,
  getSelectedFolder,
  initSidebar,
  openFolder,
  reopenLastFolder,
  setActiveFile,
  showFolderSearch,
  setOutlineSource,
  toggleSidebar,
  updateOutline,
} from "./sidebar";
import { initSplitResizer } from "./split";
import { setStatus } from "./statusbar";
import { checkForUpdate } from "./update-check";

const MD_FILTERS = [
  { name: "Markdown", extensions: ["md", "markdown", "txt"] },
];

const panesEl = document.getElementById("panes")!;
const paneTemplate = document.getElementById(
  "pane-template",
) as HTMLTemplateElement;
const toolbarEl = document.getElementById("toolbar")!;
const themeButton = document.getElementById("theme-button")!;
const themeList = document.getElementById("theme-list")!;

/** One open document: its own editor, source view and file state. At most two panes, side by side. */
interface Pane {
  el: HTMLElement;
  editorEl: HTMLElement;
  sourceEl: HTMLTextAreaElement;
  titleEl: HTMLElement;
  changeBar: HTMLElement;
  editor: Editor;
  path: string | null;
  /** Full text (front matter included) as last saved or loaded. */
  savedMarkdown: string;
  /** YAML front matter, kept outside the editor; null when the document has none. */
  front: string | null;
  frontEl: HTMLDetailsElement;
  dirty: boolean;
  sourceMode: boolean;
  knownMtime: number | null;
  externalChange: number | null | undefined;
  autosaveTimer: number | undefined;
}

const MAX_PANES = 2;
const AUTOSAVE_DELAY = 2000;
const SESSION_DELAY = 1000;
const panes: Pane[] = [];
let active!: Pane;
let autosaveOn = true;
let sessionTimer: number | undefined;
let search!: ReturnType<typeof initSearch>;

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
  {
    tag: [t.keyword, t.modifier, t.controlKeyword],
    color: "var(--hl-keyword)",
  },
  { tag: [t.string, t.regexp, t.special(t.string)], color: "var(--hl-string)" },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: "var(--hl-comment)",
    fontStyle: "italic",
  },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--hl-number)" },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.definition(t.variableName),
    ],
    color: "var(--hl-fn)",
  },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--hl-type)" },
  {
    tag: [t.propertyName, t.attributeName, t.tagName],
    color: "var(--hl-prop)",
  },
  { tag: [t.operator, t.punctuation], color: "var(--hl-op)" },
]);

const resizerEl = document.createElement("div");
resizerEl.id = "pane-resizer";
initSplitResizer(panesEl, resizerEl);

document.addEventListener("selectionchange", scheduleStatus);

// The native menu (Inspect Element) stays off everywhere except text fields; document panes have their own menu
document.addEventListener("contextmenu", (event) => {
  if (!(
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement
  ))
    event.preventDefault();
});

void checkForUpdate();
initSidebar({
  onOpenFile: (path, side) =>
    void openPath(path, side).catch((error) =>
      showToast(String(error), "error"),
    ),
  onOpenMatch: (path, query, side) =>
    void openPath(path, side)
      .then(() => search?.openWith(query))
      .catch((error) => showToast(String(error), "error")),
  onOpenTerminal: (dir) =>
    void restartTerminal(dir).catch((error) =>
      showToast(String(error), "error"),
    ),
  onOpenFileManager: (dir) =>
    void invoke("open_in_file_manager", { path: dir }).catch((error) =>
      showToast(String(error), "error"),
    ),
  onOpenCodeEditor: (dir) =>
    void invoke("open_in_code_editor", { path: dir }).catch((error) =>
      showToast(String(error), "error"),
    ),
});

async function createPane(): Promise<Pane> {
  const el = (paneTemplate.content.firstElementChild as HTMLElement).cloneNode(
    true,
  ) as HTMLElement;
  const editorEl = el.querySelector<HTMLElement>(".pane-editor")!;
  const sourceEl = el.querySelector<HTMLTextAreaElement>(".pane-source")!;
  const pane = {
    el,
    editorEl,
    sourceEl,
    titleEl: el.querySelector<HTMLElement>(".pane-title")!,
    changeBar: el.querySelector<HTMLElement>(".external-change")!,
    path: null,
    savedMarkdown: "",
    front: null,
    frontEl: el.querySelector<HTMLDetailsElement>(".pane-frontmatter")!,
    dirty: false,
    sourceMode: false,
    knownMtime: null,
    externalChange: undefined,
    autosaveTimer: undefined,
  } as unknown as Pane;

  pane.editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, editorEl);
      ctx.set(defaultValueCtx, "");
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        setDirty(
          pane,
          joinFrontMatter(pane.front, markdown) !== pane.savedMarkdown,
        );
        if (pane === active) {
          updateOutline();
          scheduleStatus();
        }
        scheduleAutosave(pane);
        scheduleSession();
      });
      ctx.update(codeBlockConfig.key, (config) => ({
        ...config,
        languages: [...languages, mermaidLanguage],
        previewLabel: "Preview",
        previewLoading: "Rendering diagram...",
        previewToggleButton: (previewOnly: boolean) =>
          previewOnly ? "Edit" : "Hide",
        renderPreview: (
          language: string,
          content: string,
          applyPreview: (value: string | null) => void,
        ) => {
          if (!isMermaidLanguage(language) || !content.trim()) return null;
          renderMermaid(content)
            .then((svg) =>
              applyPreview(`<div class="mermaid-diagram">${svg}</div>`),
            )
            .catch((error: unknown) => {
              const message =
                error instanceof Error ? error.message : String(error);
              applyPreview(
                `<div class="mermaid-error">${escapeHtml(message)}</div>`,
              );
            });
          return undefined;
        },
        extensions: [
          syntaxHighlighting(highlightStyle),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ spellcheck: "false" }),
        ],
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
        onUpload: (file: File) => uploadImageFile(file, pane.path),
        proxyDomURL: (url: string) => proxyImageUrl(url, pane.path),
      }));
      ctx.update(inlineImageConfig.key, (config) => ({
        ...config,
        ...imageTexts,
        imageIcon: "\u25A3",
        onUpload: (file: File) => uploadImageFile(file, pane.path),
        proxyDomURL: (url: string) => proxyImageUrl(url, pane.path),
      }));
      ctx.update(uploadConfig.key, (config) => ({
        ...config,
        uploader: (files: FileList, schema: Schema) =>
          uploadImages(files, schema, pane.path),
      }));
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
    .use(compositionInlineCode)
    .use(gapCursorPlugin)
    .use(mathPlugin)
    .use(searchPlugin)
    .use(trailing)
    .create();

  initContextMenu(pane.editor, editorEl);
  // Ctrl/Cmd+click on a link: local Markdown files open here (Shift: beside), web links in the browser
  editorEl.addEventListener("click", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const href = (event.target as Element)
      .closest("a[href]")
      ?.getAttribute("href");
    if (!href) return;
    event.preventDefault();
    if (isExternalLink(href)) {
      void openUrl(href).catch((error) => showToast(String(error), "error"));
      return;
    }
    if (!pane.path) {
      showToast("Save the document first to follow relative links", "error");
      return;
    }
    const target = resolveLocalLink(pane.path, href);
    if (target)
      void openPath(target, event.shiftKey).catch((error) =>
        showToast(String(error), "error"),
      );
  });
  applySpellcheck(pane);

  el.addEventListener("pointerdown", () => setActive(pane), true);
  el.addEventListener("focusin", () => setActive(pane));
  el.querySelector(".pane-close")!.addEventListener(
    "click",
    () =>
      void closePane(pane).catch((error) => showToast(String(error), "error")),
  );
  el.querySelector(".external-change-reload")!.addEventListener("click", () => {
    void reloadPane(pane).catch((error) => showToast(String(error), "error"));
  });
  el.querySelector(".external-change-ignore")!.addEventListener("click", () => {
    // keep the new state as the baseline: the bar returns only on a further change
    pane.knownMtime =
      pane.externalChange === null
        ? null
        : (pane.externalChange ?? pane.knownMtime);
    hideChangeBar(pane);
  });
  for (const type of ["select", "keyup", "pointerup"])
    sourceEl.addEventListener(type, scheduleStatus);
  sourceEl.addEventListener("input", () => {
    setDirty(pane, sourceEl.value !== pane.savedMarkdown);
    if (pane === active) {
      search?.onSourceInput();
      scheduleStatus();
    }
    scheduleAutosave(pane);
    scheduleSession();
  });
  const frontArea = pane.frontEl.querySelector("textarea")!;
  frontArea.addEventListener("input", () => {
    pane.front = frontArea.value;
    setDirty(pane, getContent(pane) !== pane.savedMarkdown);
    scheduleAutosave(pane);
    scheduleSession();
  });
  pane.frontEl
    .querySelector(".pane-frontmatter-remove")!
    .addEventListener("click", () => {
      showFront(pane, null);
      setDirty(pane, getContent(pane) !== pane.savedMarkdown);
      scheduleAutosave(pane);
      scheduleSession();
    });
  return pane;
}

const currentMarkdown = (pane: Pane) => pane.editor.action(getMarkdown());
/** Full text of the document, front matter included: what gets saved. */
const getContent = (pane: Pane) =>
  pane.sourceMode
    ? pane.sourceEl.value
    : joinFrontMatter(pane.front, currentMarkdown(pane));
/** Text without front matter: what gets exported. */
const getBody = (pane: Pane) =>
  pane.sourceMode
    ? splitFrontMatter(pane.sourceEl.value).body
    : currentMarkdown(pane);

function showFront(pane: Pane, front: string | null, open = false) {
  pane.front = front;
  pane.frontEl.hidden = front === null;
  pane.frontEl.querySelector("textarea")!.value = front ?? "";
  if (open) pane.frontEl.open = true;
}

/** Load a full text into the editor, front matter split off. */
function setEditorContent(pane: Pane, content: string, flush = false) {
  const { front, body } = splitFrontMatter(content);
  showFront(pane, front);
  pane.editor.action(replaceAll(body, flush));
  pane.editor.action((ctx) => hideSyntaxMarkers(ctx.get(editorViewCtx)));
}

function addFrontMatter() {
  const pane = active;
  if (pane.sourceMode) setSourceMode(pane, false);
  if (pane.front === null) {
    showFront(pane, "title: ", true);
    setDirty(pane, true);
    scheduleAutosave(pane);
    scheduleSession();
  }
  pane.frontEl.open = true;
  const area = pane.frontEl.querySelector("textarea")!;
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

const STATUS_DELAY = 200;
let statusTimer: number | undefined;

function refreshStatus() {
  if (!active) return;
  if (active.sourceMode) {
    const { value, selectionStart, selectionEnd } = active.sourceEl;
    setStatus(value, value.slice(selectionStart, selectionEnd));
    return;
  }
  active.editor.action((ctx) => {
    const { doc, selection } = ctx.get(editorViewCtx).state;
    setStatus(
      doc.textBetween(0, doc.content.size, "\n", " "),
      doc.textBetween(selection.from, selection.to, "\n", " "),
    );
  });
}

function scheduleStatus() {
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(refreshStatus, STATUS_DELAY);
}

function baseName(path: string | null): string {
  return path ? (path.split(/[\\/]/).pop() ?? path) : "Untitled";
}

function refreshTitles() {
  for (const pane of panes)
    pane.titleEl.textContent = `${pane.dirty ? "● " : ""}${baseName(pane.path)}`;
  if (!active) return;
  const title = `${active.dirty ? "● " : ""}${baseName(active.path)} | s-nib`;
  document.title = title;
  void getCurrentWindow().setTitle(title);
}

function setDirty(pane: Pane, value: boolean) {
  if (pane.dirty === value) return;
  pane.dirty = value;
  refreshTitles();
}

function setSourceMode(pane: Pane, on: boolean) {
  if (on === pane.sourceMode) return;
  if (on) {
    pane.sourceEl.value = getContent(pane);
  } else {
    setEditorContent(pane, pane.sourceEl.value);
  }
  pane.sourceMode = on;
  pane.editorEl.hidden = on;
  pane.sourceEl.hidden = !on;
  if (on) pane.sourceEl.focus();
  else if (pane === active) updateOutline();
  if (pane === active) {
    search?.refresh();
    scheduleStatus();
  }
}

function focusPane(pane: Pane) {
  if (pane.sourceMode) pane.sourceEl.focus();
  else pane.editor.action((ctx) => ctx.get(editorViewCtx).focus());
  setActive(pane);
}

/** The pane that gets the menu actions, the find bar and the window title. */
function setActive(pane: Pane) {
  if (pane === active) return;
  const previous = active;
  active = pane;
  panes.forEach((item) => item.el.classList.toggle("active", item === pane));
  setOutlineSource(pane.editorEl);
  updateOutline();
  setActiveFile(pane.path);
  refreshTitles();
  syncToolbar();
  scheduleStatus();
  search?.retarget(previous.editor);
}

function toggleBodyMode(name: string) {
  document.body.classList.toggle(name);
}

function syncThemePicker(name: string) {
  themeList
    .querySelectorAll<HTMLButtonElement>("[data-theme-value]")
    .forEach((option) => {
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

function loadContent(pane: Pane, path: string | null, content: string) {
  setSourceMode(pane, false);
  clearImageCache();
  pane.path = path;
  pane.knownMtime = null;
  hideChangeBar(pane);
  setEditorContent(pane, content, true);
  pane.savedMarkdown = getContent(pane);
  pane.dirty = false;
  refreshTitles();
  if (pane === active) {
    updateOutline();
    setActiveFile(path);
    syncToolbar();
  }
}

function discardPrompt(message: string): Promise<boolean> {
  return ask(message, {
    title: "s-nib",
    kind: "warning",
    okLabel: "Discard",
    cancelLabel: "Cancel",
  });
}

/** The pane is about to lose its document: save it by itself, or ask before discarding. */
async function releasePane(pane: Pane): Promise<boolean> {
  await autosaveNow(pane);
  if (!pane.dirty) return true;
  return discardPrompt(
    `${baseName(pane.path)} has unsaved changes. Discard them?`,
  );
}

async function addPane(): Promise<Pane> {
  const pane = await createPane();
  panesEl.append(resizerEl, pane.el);
  panesEl.classList.add("split");
  panes.push(pane);
  loadContent(pane, null, "");
  applySpellcheck(pane);
  return pane;
}

async function closePane(pane: Pane) {
  if (!(await releasePane(pane))) return;
  if (panes.length === 1) {
    loadContent(pane, null, "");
    return;
  }
  const rest = panes.find((item) => item !== pane)!;
  const wasActive = pane === active;
  panes.splice(panes.indexOf(pane), 1);
  pane.el.remove();
  resizerEl.remove();
  panesEl.classList.remove("split");
  void pane.editor.destroy();
  if (wasActive) {
    // `active` still points to the removed pane: force the switch
    active = rest;
    rest.el.classList.add("active");
    setOutlineSource(rest.editorEl);
    updateOutline();
    setActiveFile(rest.path);
    refreshTitles();
    syncToolbar();
    search.refresh();
    focusPane(rest);
  }
  scheduleSession();
}

async function toggleSplit() {
  if (panes.length > 1) {
    await closePane(panes[1]);
    return;
  }
  const pane = await addPane();
  focusPane(pane);
}

/** Left pane goes right and vice versa; each keeps its document, history and scroll position. */
function swapPanes() {
  if (panes.length < 2) return;
  const scrolls = panes.map(
    (pane) => pane.el.querySelector<HTMLElement>(".pane-scroller")!.scrollTop,
  );
  panes.reverse();
  scrolls.reverse();
  panesEl.append(panes[0].el, resizerEl, panes[1].el);
  panes.forEach((pane, index) => {
    pane.el.querySelector<HTMLElement>(".pane-scroller")!.scrollTop =
      scrolls[index];
  });
  focusPane(active);
  scheduleSession();
}

function switchPane() {
  if (panes.length > 1) focusPane(panes.find((item) => item !== active)!);
}

async function newFile() {
  if (!(await releasePane(active))) return;
  loadContent(active, null, "");
}

async function openFile() {
  const path = await open({
    multiple: false,
    directory: false,
    filters: MD_FILTERS,
  });
  if (typeof path !== "string") return;
  await openPath(path, false);
}

/** `side`: open in the other pane, creating it when there is only one. */
async function openPath(path: string, side: boolean) {
  const existing = panes.find((pane) => pane.path === path);
  if (existing) {
    focusPane(existing);
    return;
  }
  const content = await invoke<string>("read_text_file", { path });
  let target = active;
  if (side && panes.length < MAX_PANES) {
    target = await addPane();
  } else {
    if (side) target = panes.find((pane) => pane !== active)!;
    if (!(await releasePane(target))) return;
  }
  loadContent(target, path, content);
  await syncMtime(target);
  focusPane(target);
  scheduleSession();
}

/** Read the file of a pane again from disk (external change bar). */
async function reloadPane(pane: Pane) {
  if (!pane.path) return;
  loadContent(
    pane,
    pane.path,
    await invoke<string>("read_text_file", { path: pane.path }),
  );
  await syncMtime(pane);
}

function hideChangeBar(pane: Pane) {
  pane.changeBar.hidden = true;
  pane.externalChange = undefined;
}

async function syncMtime(pane: Pane) {
  hideChangeBar(pane);
  pane.knownMtime = pane.path
    ? await invoke<number | null>("file_mtime", { path: pane.path })
    : null;
}

/** Compare the file on disk with the version loaded or saved here. */
async function checkExternalChange(pane: Pane) {
  if (!pane.path || pane.knownMtime === null) return;
  let mtime: number | null;
  try {
    mtime = await invoke<number | null>("file_mtime", { path: pane.path });
  } catch {
    return;
  }
  if (mtime === pane.knownMtime || mtime === pane.externalChange) return;
  pane.externalChange = mtime;
  const name = baseName(pane.path);
  const unsaved = pane.dirty ? " Reloading discards your unsaved changes." : "";
  pane.changeBar.querySelector(".external-change-text")!.textContent =
    mtime === null
      ? `${name} was deleted or moved outside s-nib.`
      : `${name} was changed outside s-nib.${unsaved}`;
  pane.changeBar.querySelector<HTMLButtonElement>(
    ".external-change-reload",
  )!.hidden = mtime === null;
  pane.changeBar.hidden = false;
}

const checkAll = () => panes.forEach((pane) => void checkExternalChange(pane));
void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
  if (focused) checkAll();
});
window.setInterval(() => {
  if (document.hasFocus()) checkAll();
}, 2000);

async function saveFile(pane: Pane, forceDialog = false): Promise<boolean> {
  let path = pane.path;
  if (!path || forceDialog) {
    path = await save({
      filters: MD_FILTERS,
      defaultPath: pane.path ?? "untitled.md",
    });
    if (!path) return false;
  }
  const content = getContent(pane);
  await invoke("write_text_file", { path, content });
  pane.path = path;
  void invoke("history_add", { path, content }).catch(() => undefined);
  pane.savedMarkdown = content;
  pane.dirty = false;
  scheduleSession();
  refreshTitles();
  if (pane === active) setActiveFile(path);
  await syncMtime(pane);
  return true;
}

/** Save a pane by itself after a pause in typing, unless the file changed on disk meanwhile. */
async function autosaveNow(pane: Pane) {
  window.clearTimeout(pane.autosaveTimer);
  if (!autosaveOn || !pane.dirty || !pane.path || !pane.changeBar.hidden)
    return;
  try {
    const mtime = await invoke<number | null>("file_mtime", {
      path: pane.path,
    });
    if (mtime !== pane.knownMtime) {
      await checkExternalChange(pane);
      return;
    }
    await saveFile(pane, false);
  } catch (error) {
    showToast(`Autosave failed: ${String(error)}`, "error");
  }
}

function scheduleAutosave(pane: Pane) {
  window.clearTimeout(pane.autosaveTimer);
  if (autosaveOn && pane.dirty && pane.path)
    pane.autosaveTimer = window.setTimeout(
      () => void autosaveNow(pane),
      AUTOSAVE_DELAY,
    );
}

/** Recovery copy of the unsaved documents: restored after a crash, removed on a clean exit. */
async function writeSession() {
  const unsaved = panes
    .filter((pane) => pane.dirty)
    .map((pane) => ({ path: pane.path, content: getContent(pane) }))
    .filter((item) => item.path || item.content.trim());
  try {
    if (!unsaved.length) await invoke("clear_session");
    else
      await invoke("save_session", { json: JSON.stringify({ tabs: unsaved }) });
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
  try {
    const data = JSON.parse(raw);
    items = (data.tabs as { path: unknown; content: unknown }[])
      .filter(
        (item) =>
          typeof item.content === "string" &&
          (typeof item.path === "string" || item.path === null),
      )
      .map((item) => ({
        path: item.path as string | null,
        content: item.content as string,
      }))
      .slice(0, MAX_PANES);
  } catch {
    // damaged file: treated as empty
  }
  // a copy identical to the file on disk was saved after the snapshot: nothing to recover
  const pending: typeof items = [];
  for (const item of items) {
    const onDisk = item.path
      ? await invoke<string>("read_text_file", { path: item.path }).catch(
          () => null,
        )
      : null;
    if (onDisk !== item.content) pending.push(item);
  }
  items = pending;
  if (!items.length) {
    await invoke("clear_session");
    return;
  }
  const label =
    items.length === 1
      ? "1 unsaved document"
      : `${items.length} unsaved documents`;
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
  for (const [index, { path, content }] of items.entries()) {
    const pane = index === 0 ? panes[0] : await addPane();
    let onDisk = "";
    if (path) {
      try {
        onDisk = await invoke<string>("read_text_file", { path });
      } catch {
        // file no longer readable: the recovered text will be saved as new
      }
    }
    loadContent(pane, path, content);
    if (path) await syncMtime(pane);
    pane.savedMarkdown = onDisk;
    pane.dirty = true;
  }
  refreshTitles();
  focusPane(panes[0]);
}

async function showHistory() {
  const pane = active;
  if (!pane.path) {
    showToast("Save the document first to have a history", "error");
    return;
  }
  const path = pane.path;
  await openHistory(path, (content) => {
    // keep the current text too: autosave would overwrite it a moment after the restore
    void invoke("history_add", {
      path,
      content: getContent(pane),
      force: true,
    }).catch(() => undefined);
    setSourceMode(pane, false);
    setEditorContent(pane, content);
    setDirty(pane, getContent(pane) !== pane.savedMarkdown);
    scheduleAutosave(pane);
    scheduleSession();
    focusPane(pane);
  });
}

async function insertImage() {
  const pane = active;
  if (pane.sourceMode) setSourceMode(pane, false);
  const src = await pickImage(pane.path);
  if (!src) return;
  pane.editor.action((ctx) => {
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
      Math.min(
        Number(input.max),
        Math.max(1, Math.round(Number(input.value)) || 1),
      );
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
  const pane = active;
  if (pane.sourceMode) setSourceMode(pane, false);
  const size = await askTableSize();
  if (!size) return;
  pane.editor.action(callCommand(insertTableCommand.key, size));
  pane.editor.action((ctx) => ctx.get(editorViewCtx).focus());
}

function setAutosave(on: boolean) {
  autosaveOn = on;
  showToast(`Autosave ${on ? "on" : "off"}`);
  try {
    localStorage.setItem("autosave", String(on));
  } catch {
    // storage unavailable: setting not remembered
  }
  panes.forEach(scheduleAutosave);
}

type SpellMode = "off" | "en" | "it" | "both";
const SPELL_LANGUAGES: Record<SpellMode, string[]> = {
  off: [],
  en: ["en_US"],
  it: ["it_IT"],
  both: ["it_IT", "en_US"],
};
let spellMode: SpellMode = "both";

function applySpellcheck(pane: Pane) {
  pane.editorEl.spellcheck = spellMode !== "off";
  pane.editorEl.lang = spellMode === "it" ? "it" : "en";
}

function setSpellcheck(mode: SpellMode) {
  spellMode = mode;
  panes.forEach(applySpellcheck);
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
  search_folder: showFolderSearch,
  save: () => saveFile(active, false),
  save_as: () => saveFile(active, true),
  history: showHistory,
  autosave: () => setAutosave(!autosaveOn),
  close_pane: () => closePane(active),
  toggle_terminal: toggleTerminal,
  restart_terminal: () => restartTerminal(terminalFolder()),
  split_terminal: () => splitTerminal(terminalFolder()),
  toggle_split: toggleSplit,
  switch_pane: switchPane,
  swap_panes: swapPanes,
  spell_off: () => setSpellcheck("off"),
  spell_en: () => setSpellcheck("en"),
  spell_it: () => setSpellcheck("it"),
  spell_both: () => setSpellcheck("both"),
  insert_image: insertImage,
  insert_table: insertTable,
  insert_front_matter: addFrontMatter,
  about: showAbout,
  export_html: () => exportHtml(getBody(active), active.path),
  export_pdf: () => exportPdf(getBody(active), active.path),
  export_docx: () => exportPandoc(getBody(active), active.path, "docx"),
  export_odt: () => exportPandoc(getBody(active), active.path, "odt"),
  pdf_settings: () => editPdfSettings(),
  print: () => {
    setSourceMode(active, false);
    return printDocument();
  },
  quit: () => getCurrentWindow().close(),
  toggle_sidebar: toggleSidebar,
  source: () => setSourceMode(active, !active.sourceMode),
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
    source: active.sourceMode,
    focus: document.body.classList.contains("focus-mode"),
    typewriter: document.body.classList.contains("typewriter"),
    toggle_sidebar: !document
      .getElementById("app")!
      .classList.contains("no-sidebar"),
    toggle_split: panes.length > 1,
  };
  toolbarEl
    .querySelectorAll<HTMLButtonElement>("[data-action]")
    .forEach((button) => {
      const action = button.dataset.action ?? "";
      if (action === "swap_panes") button.hidden = panes.length < 2;
      if (!(action in state)) return;
      button.classList.toggle("active", state[action]);
      button.setAttribute("aria-pressed", String(state[action]));
    });
}

/** Folder for the shell: the folder selected in the tree, else the open folder, else the folder of the active file. */
function terminalFolder(): string | null {
  const folder = getSelectedFolder() ?? getCurrentFolder();
  if (folder) return folder;
  const path = active.path;
  const cut = path
    ? Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
    : -1;
  return path && cut > 0 ? path.slice(0, cut) : null;
}

setTerminalFolderProvider(terminalFolder);
document
  .getElementById("terminal-toggle")!
  .addEventListener("click", () => void toggleTerminal());

async function toggleTerminal() {
  if (terminalVisible()) {
    hideTerminal();
    focusPane(active);
  } else {
    await showTerminal(terminalFolder());
  }
}

/** Menu shortcuts that a shell also uses: with the terminal focused they go to the shell as control keys. */
const TERMINAL_KEYS: Record<string, string> = {
  new: "\x0e",
  open: "\x0f",
  save: "\x13",
  close_pane: "\x17",
  print: "\x10",
  quit: "\x11",
};

async function runAction(name: string) {
  if (terminalFocused() && name in TERMINAL_KEYS) {
    writeToTerminal(TERMINAL_KEYS[name]);
    return;
  }
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

initPalette(
  [
    { action: "new", label: "File: New", keys: "Ctrl+N" },
    { action: "open", label: "File: Open...", keys: "Ctrl+O" },
    {
      action: "open_folder",
      label: "File: Open folder...",
      keys: "Ctrl+Shift+O",
    },
    {
      action: "search_folder",
      label: "File: Search in folder",
      keys: "Ctrl+Shift+F",
    },
    { action: "save", label: "File: Save", keys: "Ctrl+S" },
    { action: "save_as", label: "File: Save as...", keys: "Ctrl+Shift+S" },
    { action: "history", label: "File: Version history..." },
    { action: "autosave", label: "File: Toggle autosave" },
    { action: "close_pane", label: "File: Close pane", keys: "Ctrl+W" },
    { action: "export_html", label: "Export: HTML..." },
    { action: "export_pdf", label: "Export: PDF...", keys: "Ctrl+Shift+E" },
    { action: "export_docx", label: "Export: Word (DOCX)..." },
    { action: "export_odt", label: "Export: OpenDocument (ODT)..." },
    { action: "pdf_settings", label: "Export: Default PDF settings..." },
    { action: "print", label: "File: Print...", keys: "Ctrl+P" },
    { action: "insert_image", label: "Insert: Image...", keys: "Ctrl+Shift+I" },
    { action: "insert_table", label: "Insert: Table..." },
    {
      action: "insert_front_matter",
      label: "Insert: Front matter (YAML)",
      keys: "Ctrl+Shift+Y",
    },
    {
      action: "toggle_sidebar",
      label: "View: Toggle sidebar",
      keys: "Ctrl+Shift+L",
    },
    { action: "source", label: "View: Toggle source mode", keys: "Ctrl+/" },
    {
      action: "toggle_terminal",
      label: "View: Toggle terminal",
      keys: "Ctrl+Shift+T",
    },
    {
      action: "split_terminal",
      label: "View: Split terminal (up to 3)",
      keys: "Ctrl+Shift+5",
    },
    {
      action: "restart_terminal",
      label: "View: Restart terminal in the selected folder",
    },
    {
      action: "toggle_split",
      label: "View: Toggle split view",
      keys: "Ctrl+\\",
    },
    { action: "switch_pane", label: "View: Switch pane", keys: "F6" },
    { action: "swap_panes", label: "View: Swap panes", keys: "Ctrl+Shift+\\" },
    { action: "focus", label: "View: Toggle focus mode" },
    { action: "typewriter", label: "View: Toggle typewriter mode" },
    { action: "theme_auto", label: "Theme: Automatic" },
    { action: "theme_github", label: "Theme: GitHub" },
    { action: "theme_newsprint", label: "Theme: Newsprint" },
    { action: "theme_night", label: "Theme: Night" },
    { action: "theme_slate", label: "Theme: Slate" },
    { action: "spell_off", label: "Spellcheck: Off" },
    { action: "spell_en", label: "Spellcheck: English" },
    { action: "spell_it", label: "Spellcheck: Italian" },
    { action: "spell_both", label: "Spellcheck: English and Italian" },
    { action: "about", label: "Help: About s-nib" },
  ],
  (action) => void runAction(action),
);

toolbarEl.addEventListener("mousedown", (event) => {
  // keep the buttons from taking focus away from the editor
  if ((event.target as Element).closest("button")) event.preventDefault();
});
toolbarEl.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLElement>(
    "[data-action]",
  );
  if (button?.dataset.action) void runAction(button.dataset.action);
});
themeButton.addEventListener("click", () => {
  const opening = themeList.hidden;
  themeList.hidden = !opening;
  themeButton.setAttribute("aria-expanded", String(opening));
});
themeList.addEventListener("click", (event) => {
  const option = (event.target as Element).closest<HTMLElement>(
    "[data-theme-value]",
  );
  if (!option?.dataset.themeValue) return;
  setTheme(option.dataset.themeValue);
  closeThemeList();
});
document.addEventListener("pointerdown", (event) => {
  if (!themeList.hidden && !(event.target as Element).closest("#theme-picker"))
    closeThemeList();
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
  document.documentElement.style.setProperty(
    "--sidebar-zoom",
    String(sidebarZoom),
  );
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

// Native drag and drop (needs dragDropEnabled): paths into the terminal, images into the editor
void getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type !== "drop") return;
  const { paths, position } = event.payload;
  const x = position.x / window.devicePixelRatio;
  const y = position.y / window.devicePixelRatio;
  if (terminalContainsPoint(x, y)) {
    pasteFilePaths(paths, x, y);
    return;
  }
  const pane = active;
  if (!pane || pane.sourceMode) return;
  void pane.editor
    .action(async (ctx) => {
      const view = ctx.get(editorViewCtx);
      const nodes = await importImagePaths(paths, view.state.schema, pane.path);
      if (!nodes.length) return;
      const pos =
        view.posAtCoords({ left: x, top: y })?.pos ?? view.state.selection.to;
      view.dispatch(view.state.tr.insert(pos, nodes).scrollIntoView());
    })
    .catch((error) => showToast(String(error), "error"));
});

document.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
    if ((event.target as Element).closest("#terminal-panel"))
      zoomTerminal(delta > 0 ? 1 : -1);
    else if ((event.target as Element).closest("#sidebar"))
      setSidebarZoom(sidebarZoom + delta);
    else setZoom(zoom + delta);
  },
  { passive: false },
);
// Layout independent: with Shift a non-US layout reports "%" instead of "5", which a menu accelerator misses
document.addEventListener(
  "keydown",
  (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
    if (event.code !== "Digit5") return;
    event.preventDefault();
    event.stopPropagation();
    void splitTerminal(terminalFolder()).catch(() => undefined);
  },
  true,
);
document.addEventListener("keydown", (event) => {
  if (!event.ctrlKey || event.altKey) return;
  if (terminalFocused()) {
    if (event.key === "+" || event.key === "=") zoomTerminal(1);
    else if (event.key === "-") zoomTerminal(-1);
    else if (event.key === "0") zoomTerminal();
    else return;
    event.preventDefault();
    return;
  }
  if (event.key === "+" || event.key === "=") setZoom(zoom + ZOOM_STEP);
  else if (event.key === "-") setZoom(zoom - ZOOM_STEP);
  else if (event.key === "0") setZoom(1);
  else return;
  event.preventDefault();
});

void getCurrentWindow().onCloseRequested(async (event) => {
  for (const pane of panes) await autosaveNow(pane);
  const unsaved = panes.filter((pane) => pane.dirty).length;
  if (unsaved) {
    const message =
      unsaved === 1
        ? "You have unsaved changes. Discard them?"
        : `${unsaved} documents have unsaved changes. Discard them?`;
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
  const savedSpell = localStorage.getItem("spellcheck");
  if (savedSpell && savedSpell in SPELL_LANGUAGES)
    spellMode = savedSpell as SpellMode;
} catch {
  // storage unavailable: autosave on, English and Italian spellcheck
}

{
  const first = await createPane();
  panesEl.append(first.el);
  panes.push(first);
  active = first;
  first.el.classList.add("active");
  setOutlineSource(first.editorEl);
  applySpellcheck(first);
}
search = initSearch(() => ({
  editor: active.editor,
  sourceEl: active.sourceEl,
  root: active.el,
  sourceMode: active.sourceMode,
}));
setSpellcheck(spellMode);
refreshTitles();
refreshStatus();
syncToolbar();

// Documents left unsaved by a crash, then the file passed on the command line (for example from the file manager)
await restoreSession();
const initialFile = await invoke<string | null>("initial_file");
if (initialFile) await openPath(initialFile, false);
else await reopenLastFolder();

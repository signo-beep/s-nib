import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { showContextMenu } from "./context-menu";

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

interface SidebarOptions {
  /** `side`: Ctrl or Cmd held, open next to the active document. */
  onOpenFile: (path: string, side: boolean) => void;
  /** A folder search result: open the file and look for the text in it. */
  onOpenMatch: (path: string, query: string, side: boolean) => void;
  /** Open a terminal in a folder of the tree. */
  onOpenTerminal: (dir: string) => void;
  /** Open a folder of the tree in the system file manager. */
  onOpenFileManager: (dir: string) => void;
  /** Open a folder of the tree in VSCodium / VS Code. */
  onOpenCodeEditor: (dir: string) => void;
}

interface SearchHit {
  path: string;
  name: string;
  line: number;
  text: string;
}

const app = document.getElementById("app")!;
const tree = document.getElementById("tree") as HTMLUListElement;
const outline = document.getElementById("outline") as HTMLUListElement;
const folderName = document.getElementById("folder-name")!;
let outlineRoot: HTMLElement | null = null;

let activePath: string | null = null;
let currentFolder: string | null = null;
let selectedDir: string | null = null;
let options: SidebarOptions;

/** Called when a tab added with `addSidebarTab` is shown. */
const tabHooks = new Map<string, () => void>();

/** Adds a tab and returns its (empty) panel; used by optional extensions such as the database connector. */
export function addSidebarTab(name: string, label: string, onShow?: () => void): HTMLElement {
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "tab";
  tab.dataset.tab = name;
  tab.textContent = label;
  tab.addEventListener("click", () => showTab(name));
  document.querySelector(".tabs")!.append(tab);
  const panel = document.createElement("section");
  panel.id = `panel-${name}`;
  panel.className = "panel";
  panel.hidden = true;
  document.getElementById("sidebar")!.append(panel);
  if (onShow) tabHooks.set(name, onShow);
  return panel;
}

/** Shows a tab (the sidebar is opened if hidden). */
export function showSidebarTab(name: string) {
  app.classList.remove("no-sidebar");
  showTab(name);
}

function showTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === name);
  });
  document.querySelectorAll<HTMLElement>(".panel").forEach((panel) => {
    panel.hidden = panel.id !== `panel-${name}`;
  });
  tabHooks.get(name)?.();
  if (name === "links") void refreshBacklinks();
  if (name === "search")
    (
      document.getElementById("folder-search-input") as HTMLInputElement
    ).focus();
}

function relativePath(path: string): string {
  if (currentFolder && path.startsWith(currentFolder))
    return path.slice(currentFolder.length).replace(/^[\\/]+/, "");
  return path;
}

/** Result list grouped by file: a header per file, a button per matching line. */
function renderHits(
  list: HTMLUListElement,
  hits: SearchHit[],
  onOpen: (hit: SearchHit, event: MouseEvent) => void,
) {
  list.replaceChildren();
  let lastPath = "";
  for (const hit of hits) {
    if (hit.path !== lastPath) {
      lastPath = hit.path;
      const header = document.createElement("li");
      header.className = "search-file";
      header.textContent = relativePath(hit.path);
      header.title = hit.path;
      list.append(header);
    }
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-hit";
    const line = document.createElement("span");
    line.className = "line";
    line.textContent = String(hit.line);
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = hit.text;
    button.title = hit.text;
    button.append(line, text);
    button.addEventListener("click", (event) => onOpen(hit, event));
    item.append(button);
    list.append(item);
  }
}

/** Backlinks tab: the lines of the other documents in the open folder that link to the active file. */
let backlinksToken = 0;
async function refreshBacklinks() {
  if (document.getElementById("panel-links")!.hidden) return;
  const status = document.getElementById("backlinks-status")!;
  const results = document.getElementById(
    "backlinks-results",
  ) as HTMLUListElement;
  results.replaceChildren();
  if (!currentFolder) {
    status.textContent = "Open a folder first";
    return;
  }
  if (!activePath) {
    status.textContent = "Save the document to see its backlinks";
    return;
  }
  const current = ++backlinksToken;
  status.textContent = "Searching...";
  let found: { hits: SearchHit[]; truncated: boolean };
  try {
    found = await invoke("find_backlinks", {
      root: currentFolder,
      target: activePath,
    });
  } catch (error) {
    if (current === backlinksToken) status.textContent = String(error);
    return;
  }
  if (current !== backlinksToken) return;
  const files = new Set(found.hits.map((hit) => hit.path)).size;
  status.textContent = found.hits.length
    ? `${found.hits.length}${found.truncated ? "+" : ""} links from ${files} files${found.truncated ? " (partial)" : ""}`
    : "No links to this file";
  renderHits(results, found.hits, (hit, event) =>
    options.onOpenFile(hit.path, event.ctrlKey || event.metaKey),
  );
}

function initFolderSearch() {
  const input = document.getElementById(
    "folder-search-input",
  ) as HTMLInputElement;
  const caseButton = document.getElementById("folder-search-case")!;
  const status = document.getElementById("folder-search-status")!;
  const results = document.getElementById(
    "folder-search-results",
  ) as HTMLUListElement;
  let caseSensitive = false;
  let token = 0;

  async function run() {
    const query = input.value;
    results.replaceChildren();
    if (!query.trim()) {
      status.textContent = "";
      return;
    }
    if (!currentFolder) {
      status.textContent = "Open a folder first";
      return;
    }
    const current = ++token;
    status.textContent = "Searching...";
    let found: { hits: SearchHit[]; truncated: boolean };
    try {
      found = await invoke("search_folder", {
        root: currentFolder,
        query,
        caseSensitive,
      });
    } catch (error) {
      if (current === token) status.textContent = String(error);
      return;
    }
    if (current !== token) return;
    const files = new Set(found.hits.map((hit) => hit.path)).size;
    status.textContent = found.hits.length
      ? `${found.hits.length}${found.truncated ? "+" : ""} results in ${files} files${found.truncated ? " (partial)" : ""}`
      : "No results";
    renderHits(results, found.hits, (hit, event) =>
      options.onOpenMatch(hit.path, query, event.ctrlKey || event.metaKey),
    );
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void run();
    }
  });
  caseButton.addEventListener("click", () => {
    caseSensitive = !caseSensitive;
    caseButton.classList.toggle("active", caseSensitive);
    caseButton.setAttribute("aria-pressed", String(caseSensitive));
    void run();
  });
}

/** Subfolder last clicked in the tree (a click on a file clears it), or null. */
export function getSelectedFolder(): string | null {
  return selectedDir;
}

function selectDir(path: string | null) {
  selectedDir = path;
  tree
    .querySelectorAll<HTMLButtonElement>(".tree-item.dir")
    .forEach((button) => {
      button.classList.toggle(
        "selected",
        !!path && button.dataset.path === path,
      );
    });
}

/** Folder shown in the sidebar, or null if none is open. */
export function getCurrentFolder(): string | null {
  return currentFolder;
}

/** Shows the folder search tab (the sidebar is opened if hidden). */
export function showFolderSearch() {
  app.classList.remove("no-sidebar");
  showTab("search");
}

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function createItem(entry: DirEntry): HTMLLIElement {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tree-item";
  button.textContent = entry.name;
  button.title = entry.path;
  button.dataset.path = entry.path;
  item.append(button);
  if (entry.is_dir) {
    button.classList.add("dir");
    const children = document.createElement("ul");
    children.hidden = true;
    item.append(children);
    button.addEventListener("click", async () => {
      selectDir(entry.path);
      const opening = !!children.hidden;
      children.hidden = !opening;
      button.classList.toggle("open", opening);
      if (opening) await syncEntries(children, entry.path, true);
    });
  } else {
    if (entry.path === activePath) button.classList.add("active");
    button.addEventListener("click", (event) => {
      selectDir(null);
      options.onOpenFile(entry.path, event.ctrlKey || event.metaKey);
    });
  }
  return item;
}

function emptyItem(text: string): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "empty";
  item.textContent = text;
  return item;
}

/**
 * Brings a list in line with the folder on disk: items that are gone are removed, new ones are added in
 * order, existing ones (and the subfolders that are open) stay as they are. `reportError` shows a failed
 * read in the list; otherwise the list is left untouched.
 */
async function syncEntries(
  list: HTMLUListElement,
  dir: string,
  reportError: boolean,
): Promise<boolean> {
  let entries: DirEntry[];
  try {
    entries = await invoke<DirEntry[]>("list_dir", { path: dir });
  } catch (error) {
    if (reportError) list.replaceChildren(emptyItem(String(error)));
    return false;
  }
  list.querySelectorAll(":scope > li.empty").forEach((item) => item.remove());
  const existing = new Map<string, HTMLLIElement>();
  for (const item of Array.from(list.children) as HTMLLIElement[]) {
    const path = item.querySelector<HTMLElement>(":scope > .tree-item")
      ?.dataset.path;
    if (path) existing.set(path, item);
  }
  const wanted = new Set(entries.map((entry) => entry.path));
  for (const [path, item] of existing) if (!wanted.has(path)) item.remove();
  const open: Promise<boolean>[] = [];
  entries.forEach((entry, index) => {
    const item = existing.get(entry.path) ?? createItem(entry);
    if (list.children[index] !== item)
      list.insertBefore(item, list.children[index] ?? null);
    const children = item.querySelector<HTMLUListElement>(":scope > ul");
    if (entry.is_dir && children && !children.hidden)
      open.push(syncEntries(children, entry.path, false));
  });
  if (entries.length === 0) list.append(emptyItem("No Markdown files"));
  await Promise.all(open);
  return true;
}

let treeSyncing = false;
/** Picks up files and folders created, renamed or deleted outside s-nib, keeping the open folders open. */
async function refreshTree() {
  if (!currentFolder || treeSyncing) return;
  treeSyncing = true;
  try {
    await syncEntries(tree, currentFolder, false);
  } finally {
    treeSyncing = false;
  }
}

export function setActiveFile(path: string | null) {
  activePath = path;
  void refreshBacklinks();
  tree.querySelectorAll<HTMLButtonElement>(".tree-item").forEach((button) => {
    button.classList.toggle("active", !!path && button.dataset.path === path);
  });
}

/** Pane whose headings the outline shows. */
export function setOutlineSource(root: HTMLElement) {
  outlineRoot = root;
}

export function updateOutline() {
  outline.replaceChildren();
  const headings = (outlineRoot ?? document.body).querySelectorAll<HTMLElement>(
    ".ProseMirror h1, .ProseMirror h2, .ProseMirror h3, .ProseMirror h4, .ProseMirror h5, .ProseMirror h6",
  );
  let count = 0;
  headings.forEach((heading) => {
    const text = heading.textContent?.trim();
    if (!text) return;
    count++;
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `outline-item lvl-${heading.tagName.slice(1)}`;
    button.textContent = text;
    button.addEventListener("click", () => {
      heading.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    item.append(button);
    outline.append(item);
  });
  if (count === 0) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = "No headings";
    outline.append(item);
  }
}

const SIDEBAR_MIN = 180;
const SIDEBAR_DEFAULT = 260;
const SIDEBAR_STEP = 16;

function setSidebarWidth(px: number, persist = true) {
  const max = Math.max(SIDEBAR_MIN, window.innerWidth * 0.6);
  const width = Math.round(Math.min(max, Math.max(SIDEBAR_MIN, px)));
  app.style.setProperty("--sidebar-width", `${width}px`);
  if (persist) {
    try {
      localStorage.setItem("sidebarWidth", String(width));
    } catch {
      // storage unavailable: the width only applies to this session
    }
  }
  return width;
}

function initResizer() {
  const handle = document.getElementById("sidebar-resizer")!;
  const sidebar = document.getElementById("sidebar")!;
  try {
    const saved = Number(localStorage.getItem("sidebarWidth"));
    if (saved) setSidebarWidth(saved, false);
  } catch {
    // storage unavailable: default width
  }
  const currentWidth = () => sidebar.getBoundingClientRect().width;

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    setSidebarWidth(
      event.clientX - sidebar.getBoundingClientRect().left,
      false,
    );
  });
  const endDrag = (event: PointerEvent) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    handle.releasePointerCapture(event.pointerId);
    document.body.classList.remove("resizing");
    setSidebarWidth(currentWidth());
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  handle.addEventListener("dblclick", () => setSidebarWidth(SIDEBAR_DEFAULT));
  handle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? SIDEBAR_STEP : -SIDEBAR_STEP;
    setSidebarWidth(currentWidth() + delta);
  });
}

export function toggleSidebar() {
  app.classList.toggle("no-sidebar");
}

const RECENT_MAX = 7;
const recentMenu = document.getElementById("recent-menu") as HTMLUListElement;

function loadRecents(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem("recentFolders") ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function saveRecents(list: string[]) {
  try {
    localStorage.setItem(
      "recentFolders",
      JSON.stringify(list.slice(0, RECENT_MAX)),
    );
  } catch {
    // storage unavailable: recent folders only last for this session
  }
}

function addRecent(dir: string) {
  saveRecents([dir, ...loadRecents().filter((item) => item !== dir)]);
}

function removeRecent(dir: string) {
  saveRecents(loadRecents().filter((item) => item !== dir));
}

function closeRecentMenu() {
  recentMenu.hidden = true;
  folderName.setAttribute("aria-expanded", "false");
}

function renderRecentMenu() {
  recentMenu.replaceChildren();
  const recents = loadRecents();
  if (recents.length > 0) {
    const label = document.createElement("li");
    label.className = "recent-label";
    label.textContent = "Recent folders";
    recentMenu.append(label);
  }
  for (const dir of recents) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-item";
    if (dir === folderName.title) button.classList.add("current");
    const name = document.createElement("span");
    name.textContent = baseName(dir);
    const path = document.createElement("span");
    path.className = "recent-path";
    path.textContent = dir;
    button.title = dir;
    button.append(name, path);
    button.addEventListener("click", () => {
      closeRecentMenu();
      void openFolderPath(dir);
    });
    item.append(button);
    recentMenu.append(item);
  }
  if (recents.length > 0) {
    const sep = document.createElement("li");
    sep.className = "recent-sep";
    recentMenu.append(sep);
  }
  const openItem = document.createElement("li");
  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "recent-item";
  openButton.textContent = "Open folder...";
  openButton.addEventListener("click", () => {
    closeRecentMenu();
    void openFolder();
  });
  openItem.append(openButton);
  recentMenu.append(openItem);
}

function toggleRecentMenu() {
  if (!recentMenu.hidden) {
    closeRecentMenu();
    return;
  }
  renderRecentMenu();
  recentMenu.hidden = false;
  folderName.setAttribute("aria-expanded", "true");
}

async function openFolderPath(dir: string) {
  app.classList.remove("no-sidebar");
  showTab("files");
  folderName.textContent = baseName(dir);
  folderName.title = dir;
  currentFolder = dir;
  selectedDir = null;
  tree.replaceChildren();
  if (await syncEntries(tree, dir, true)) addRecent(dir);
  else removeRecent(dir);
}

/** Reopen the most recent folder (start of a session); a folder that no longer exists is dropped from the list. */
export async function reopenLastFolder() {
  const [dir] = loadRecents();
  if (dir) await openFolderPath(dir);
}

export async function openFolder() {
  const dir = await open({ directory: true, multiple: false });
  if (typeof dir !== "string") return;
  await openFolderPath(dir);
}

export function initSidebar(sidebarOptions: SidebarOptions) {
  options = sidebarOptions;
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showTab(tab.dataset.tab ?? "files"));
  });
  folderName.addEventListener("click", toggleRecentMenu);
  document.addEventListener("pointerdown", (event) => {
    if (!recentMenu.hidden && !(event.target as Element).closest("#folder-bar"))
      closeRecentMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !recentMenu.hidden) closeRecentMenu();
  });
  // `codium` or `code`; null when no editor is installed (menu entry hidden)
  let codeEditor: string | null = null;
  void invoke<string | null>("code_editor_name")
    .then((name) => (codeEditor = name))
    .catch(() => undefined);
  tree.addEventListener("contextmenu", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>(
      ".tree-item",
    );
    const path = button?.dataset.path;
    if (!button || !path) return;
    event.preventDefault();
    const copyPath = {
      label: "Copy absolute path",
      // also PRIMARY, so a middle click pastes it in the terminal
      run: () => {
        void invoke("clipboard_set", { text: path }).catch(() => undefined);
        void invoke("primary_set", { text: path }).catch(() => undefined);
      },
    };
    if (!button.classList.contains("dir")) {
      showContextMenu([copyPath], event.clientX, event.clientY);
      return;
    }
    const dir = path;
    selectDir(dir);
    showContextMenu(
      [
        { label: "Open terminal here", run: () => options.onOpenTerminal(dir) },
        {
          label: "Open in file manager",
          run: () => options.onOpenFileManager(dir),
        },
        ...(codeEditor
          ? [
              {
                label: `Open in ${codeEditor === "codium" ? "VSCodium" : "VS Code"}`,
                run: () => options.onOpenCodeEditor(dir),
              },
            ]
          : []),
        copyPath,
      ],
      event.clientX,
      event.clientY,
    );
  });
  void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) void refreshTree();
  });
  window.setInterval(() => {
    if (document.hasFocus()) void refreshTree();
  }, 2000);
  initResizer();
  initFolderSearch();
  updateOutline();
}

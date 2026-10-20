import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { showContextMenu } from "./context-menu";
import { showToast } from "./toast";

const panel = document.getElementById("terminal-panel")!;
const grid = document.getElementById("terminal-grid")!;
const toggle = document.getElementById("terminal-toggle")!;

function setPanelHidden(hidden: boolean) {
  panel.hidden = hidden;
  toggle.classList.toggle("active", !hidden);
  toggle.setAttribute("aria-pressed", String(!hidden));
}

/** Shells open at the same time (the backend accepts the same number of slots). */
const MAX_TERMINALS = 3;

interface Cell {
  /** Backend slot. */
  id: number;
  el: HTMLElement;
  host: HTMLElement;
  title: HTMLElement;
  term: Terminal;
  fit: FitAddon;
  /** Generation of the running shell, 0 while it starts. */
  generation: number;
  /** Generations whose exit arrived before `term_start` returned. */
  exits: number[];
  observer: ResizeObserver;
}

const cells: Cell[] = [];
/** Terminal that last had the focus. */
let current: Cell | null = null;
let listening = false;
let folderProvider: () => string | null = () => null;

/** Folder where the shell of a new terminal starts (the split button has no folder of its own). */
export function setTerminalFolderProvider(provider: () => string | null) {
  folderProvider = provider;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/** ANSI colors readable on a dark background (xterm defaults are tuned for it). */
const ANSI_DARK = {
  black: "#3b4252",
  red: "#f07178",
  green: "#a6da95",
  yellow: "#eed49f",
  blue: "#8aadf4",
  magenta: "#c6a0f6",
  cyan: "#8bd5ca",
  white: "#d4d4d4",
  brightBlack: "#6e738d",
  brightRed: "#ff8b92",
  brightGreen: "#b8e8a8",
  brightYellow: "#f5e0a8",
  brightBlue: "#a4c2ff",
  brightMagenta: "#d9b8ff",
  brightCyan: "#a5e6dc",
  brightWhite: "#ffffff",
};

/** ANSI colors readable on a light background. */
const ANSI_LIGHT = {
  black: "#24292f",
  red: "#cf222e",
  green: "#1a7f37",
  yellow: "#7d4e00",
  blue: "#0550ae",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#116329",
  brightYellow: "#633c01",
  brightBlue: "#0969da",
  brightMagenta: "#6639ba",
  brightCyan: "#136061",
  brightWhite: "#24292f",
};

/** Whether a `#rrggbb` color is dark; unparsable values count as dark. */
function isDark(color: string): boolean {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) return true;
  const [red, green, blue] = [match[1], match[2], match[3]].map((hex) => parseInt(hex, 16));
  return 0.299 * red + 0.587 * green + 0.114 * blue < 128;
}

function applyTheme() {
  const background = cssVar("--bg");
  const ansi = isDark(background) ? ANSI_DARK : ANSI_LIGHT;
  for (const cell of cells)
    cell.term.options.theme = {
      ...ansi,
      background,
      foreground: cssVar("--fg"),
      cursor: cssVar("--accent"),
      selectionBackground: cssVar("--hover"),
    };
}

// Open terminals follow theme changes: the picker sets `data-theme`, the automatic theme follows the system.
new MutationObserver(applyTheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function fitCell(cell: Cell) {
  if (panel.hidden) return;
  cell.fit.fit();
  void invoke("term_resize", {
    id: cell.id,
    rows: cell.term.rows,
    cols: cell.term.cols,
  }).catch(() => undefined);
}

function fitAll() {
  cells.forEach(fitCell);
}

/** Terminal with the focus, else the last one that had it, else the first. */
function focusedCell(): Cell | null {
  return (
    cells.find((cell) => cell.el.contains(document.activeElement)) ??
    (current && cells.includes(current) ? current : (cells[0] ?? null))
  );
}

function updateButtons() {
  grid
    .querySelectorAll<HTMLButtonElement>(".terminal-split")
    .forEach((button) => {
      button.disabled = cells.length >= MAX_TERMINALS;
    });
}

const FONT_DEFAULT = 13;
const FONT_MIN = 8;
const FONT_MAX = 32;
let fontSize = FONT_DEFAULT;

try {
  const saved = Number(localStorage.getItem("terminalFontSize"));
  if (saved >= FONT_MIN && saved <= FONT_MAX) fontSize = saved;
} catch {
  // storage unavailable: default font size
}

/** Changes the terminal font size by `delta` points; without `delta` resets it. */
export function zoomTerminal(delta?: number) {
  fontSize =
    delta === undefined
      ? FONT_DEFAULT
      : Math.min(FONT_MAX, Math.max(FONT_MIN, fontSize + delta));
  for (const cell of cells) cell.term.options.fontSize = fontSize;
  fitAll();
  try {
    localStorage.setItem("terminalFontSize", String(fontSize));
  } catch {
    // storage unavailable: font size not remembered
  }
}

async function listenOnce() {
  if (listening) return;
  listening = true;
  await listen<{ id: number; data: string }>("term-data", (event) =>
    cells
      .find((cell) => cell.id === event.payload.id)
      ?.term.write(decode(event.payload.data)),
  );
  await listen<{ id: number; generation: number }>("term-exit", (event) => {
    const cell = cells.find((item) => item.id === event.payload.id);
    if (!cell) return;
    if (cell.generation === 0) cell.exits.push(event.payload.generation);
    else if (cell.generation === event.payload.generation) closeCell(cell);
  });
}

function makeButton(label: string, text: string, className: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = text;
  return button;
}

const CELL_MIN_WIDTH = 120;

/** Draggable divider between two side-by-side terminals; the pair shares its combined width. */
function makeDivider(): HTMLElement {
  const divider = document.createElement("div");
  divider.className = "terminal-divider";
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "vertical");
  divider.addEventListener("pointerdown", (event) => {
    const left = divider.previousElementSibling as HTMLElement | null;
    const right = divider.nextElementSibling as HTMLElement | null;
    if (!left || !right) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    // widths as flex weights: the proportions survive a window resize
    grid.querySelectorAll<HTMLElement>(".terminal-cell").forEach((el) => {
      el.style.flex = `${el.getBoundingClientRect().width} 1 0`;
    });
    const startX = event.clientX;
    const leftStart = left.getBoundingClientRect().width;
    const total = leftStart + right.getBoundingClientRect().width;
    const move = (moveEvent: PointerEvent) => {
      const width = Math.min(
        total - CELL_MIN_WIDTH,
        Math.max(CELL_MIN_WIDTH, leftStart + moveEvent.clientX - startX),
      );
      left.style.flex = `${width} 1 0`;
      right.style.flex = `${total - width} 1 0`;
    };
    const stop = (stopEvent: PointerEvent) => {
      divider.releasePointerCapture(stopEvent.pointerId);
      divider.removeEventListener("pointermove", move);
      divider.removeEventListener("pointerup", stop);
    };
    divider.addEventListener("pointermove", move);
    divider.addEventListener("pointerup", stop);
  });
  return divider;
}

/** Dividers between the terminals and equal widths: after a terminal is added or removed. */
function layoutCells() {
  grid.querySelectorAll(".terminal-divider").forEach((el) => el.remove());
  cells.forEach((cell, index) => {
    cell.el.style.flex = "";
    if (index > 0) cell.el.before(makeDivider());
  });
}

function createCell(): Cell {
  const id = [...Array(MAX_TERMINALS).keys()].find(
    (slot) => !cells.some((cell) => cell.id === slot),
  )!;
  const el = document.createElement("div");
  el.className = "terminal-cell";
  const bar = document.createElement("div");
  bar.className = "terminal-bar";
  const title = document.createElement("span");
  title.className = "terminal-title";
  title.textContent = "Terminal";
  const split = makeButton(
    "Split terminal (Ctrl+Shift+5)",
    "+",
    "terminal-split",
  );
  const hide = makeButton(
    "Hide terminal (Ctrl+Shift+T)",
    "\u25BE",
    "terminal-hide",
  );
  const close = makeButton("Close this terminal", "\u2715", "terminal-close");
  bar.append(title, split, hide, close);
  const host = document.createElement("div");
  host.className = "terminal-host";
  el.append(bar, host);
  grid.append(el);

  const term = new Terminal({
    fontFamily: cssVar("--font-mono") || "monospace",
    fontSize,
    cursorBlink: true,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  // WebKit + IBus: the helper textarea keeps old text and composition replays it on every accented key
  const helper = term.textarea;
  let composing = false;
  const clearHelper = () => {
    if (helper && !composing) helper.value = "";
  };
  helper?.addEventListener("compositionstart", () => {
    composing = true;
  });
  helper?.addEventListener("compositionend", () => {
    composing = false;
    setTimeout(clearHelper, 0);
  });
  helper?.addEventListener("input", () => setTimeout(clearHelper, 0));
  const cell: Cell = {
    id,
    el,
    host,
    title,
    term,
    fit,
    generation: 0,
    exits: [],
    observer: new ResizeObserver(() => fitCell(cell)),
  };
  cells.push(cell);
  layoutCells();
  current = cell;

  split.addEventListener(
    "click",
    () => void splitTerminal(folderProvider()).catch(() => undefined),
  );
  hide.addEventListener("click", hideTerminal);
  close.addEventListener("click", () => closeCell(cell));
  el.addEventListener("focusin", () => {
    current = cell;
  });

  // Copia alla selezione, incolla con la rotella: selezione PRIMARY, condivisa con gli altri terminali
  term.onSelectionChange(() => {
    const text = term.getSelection();
    if (text) void invoke("primary_set", { text }).catch(() => undefined);
  });
  // WebKit already pastes on middle click: drop that paste, auxclick below does it from PRIMARY
  let middleClickAt = 0;
  host.addEventListener(
    "mousedown",
    (e) => {
      if (e.button === 1) middleClickAt = Date.now();
    },
    true,
  );
  host.addEventListener(
    "paste",
    (e) => {
      if (Date.now() - middleClickAt > 500) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  host.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    void invoke<string>("primary_get")
      .then((text) => text && term.paste(text))
      .catch(() => undefined);
  });
  // Own menu: the native one only shows when xterm happens to put its helper textarea under the pointer
  host.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      const fail = (error: unknown) => showToast(String(error), "error");
      showContextMenu(
        [
          [
            {
              label: "Copy",
              run: async () => {
                const text = term.getSelection();
                if (text) await navigator.clipboard.writeText(text).catch(fail);
              },
            },
            {
              label: "Paste",
              run: async () => {
                const text = await invoke<string>("clipboard_get").catch(
                  () => "",
                );
                if (text) term.paste(text);
                else showToast("Clipboard empty or unreadable", "error");
                term.focus();
              },
            },
          ],
          "separator",
          { label: "Select all", run: () => term.selectAll() },
          { label: "Clear", run: () => term.clear() },
        ],
        e.clientX,
        e.clientY,
      );
    },
    true,
  );
  term.onData(
    (data) => void invoke("term_write", { id, data }).catch(() => undefined),
  );
  cell.observer.observe(host);
  updateButtons();
  return cell;
}

/** Ends the shell of a terminal and removes it; the panel hides when none is left. */
function closeCell(cell: Cell) {
  const index = cells.indexOf(cell);
  if (index < 0) return;
  cells.splice(index, 1);
  cell.observer.disconnect();
  void invoke("term_stop", { id: cell.id }).catch(() => undefined);
  cell.term.dispose();
  cell.el.remove();
  layoutCells();
  if (current === cell) current = cells[0] ?? null;
  updateButtons();
  if (cells.length === 0) hideTerminal();
  else {
    fitAll();
    focusedCell()?.term.focus();
  }
}

async function start(cell: Cell, cwd: string | null) {
  cell.generation = 0;
  cell.exits = [];
  fitCell(cell);
  cell.term.reset();
  const generation = await invoke<number>("term_start", {
    id: cell.id,
    cwd,
    rows: cell.term.rows,
    cols: cell.term.cols,
  });
  cell.generation = generation;
  cell.title.textContent = cwd ?? "Terminal";
  cell.title.title = cwd ?? "";
  if (cell.exits.includes(generation)) closeCell(cell);
}

export function terminalVisible(): boolean {
  return !panel.hidden;
}

export function terminalFocused(): boolean {
  return !panel.hidden && panel.contains(document.activeElement);
}

/** True when the point (CSS pixels) falls inside the visible terminal panel. */
export function terminalContainsPoint(x: number, y: number): boolean {
  if (panel.hidden) return false;
  const rect = panel.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** Pastes dropped file paths into the shell under the point (else the current one), quoted when they contain special characters. */
export function pasteFilePaths(paths: string[], x: number, y: number) {
  const target =
    cells.find((cell) => {
      const rect = cell.el.getBoundingClientRect();
      return (
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      );
    }) ?? focusedCell();
  if (!target) return;
  const quoted = paths.map((path) =>
    /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`,
  );
  target.term.paste(`${quoted.join(" ")} `);
  target.term.focus();
}

export function writeToTerminal(data: string) {
  const cell = focusedCell();
  if (cell)
    void invoke("term_write", { id: cell.id, data }).catch(() => undefined);
}

export function hideTerminal() {
  setPanelHidden(true);
}

/** Shows the terminals; the first shell starts in `cwd` when there is none (it also covers all having exited). */
export async function showTerminal(cwd: string | null) {
  setPanelHidden(false);
  await listenOnce();
  if (cells.length === 0) {
    const cell = createCell();
    applyTheme();
    await start(cell, cwd);
  }
  applyTheme();
  fitAll();
  focusedCell()?.term.focus();
}

/** Adds a terminal next to the others (up to 3) with a shell in `cwd`. */
export async function splitTerminal(cwd: string | null) {
  if (cells.length === 0) return showTerminal(cwd);
  if (cells.length >= MAX_TERMINALS) return;
  setPanelHidden(false);
  await listenOnce();
  const cell = createCell();
  applyTheme();
  fitAll();
  await start(cell, cwd);
  cell.term.focus();
}

/** Ends the shell of the current terminal and starts a new one in `cwd`. */
export async function restartTerminal(cwd: string | null) {
  setPanelHidden(false);
  await listenOnce();
  const cell = focusedCell() ?? createCell();
  applyTheme();
  await start(cell, cwd);
  fitAll();
  cell.term.focus();
}

// Height of the panel: drag the top edge; remembered between sessions
const HEIGHT_MIN = 120;
const resizer = document.getElementById("terminal-resizer")!;

function setHeight(px: number, persist = true) {
  const height = Math.round(
    Math.min(window.innerHeight * 0.8, Math.max(HEIGHT_MIN, px)),
  );
  panel.style.height = `${height}px`;
  if (!persist) return;
  try {
    localStorage.setItem("terminalHeight", String(height));
  } catch {
    // storage unavailable: height not remembered
  }
}

try {
  const saved = Number(localStorage.getItem("terminalHeight"));
  if (saved > 0) setHeight(saved, false);
} catch {
  // storage unavailable: default height
}

resizer.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  resizer.setPointerCapture(event.pointerId);
  const startY = event.clientY;
  const startHeight = panel.getBoundingClientRect().height;
  const move = (moveEvent: PointerEvent) =>
    setHeight(startHeight + startY - moveEvent.clientY, false);
  const stop = (stopEvent: PointerEvent) => {
    resizer.releasePointerCapture(stopEvent.pointerId);
    resizer.removeEventListener("pointermove", move);
    resizer.removeEventListener("pointerup", stop);
    setHeight(panel.getBoundingClientRect().height);
  };
  resizer.addEventListener("pointermove", move);
  resizer.addEventListener("pointerup", stop);
});

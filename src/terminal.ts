import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

const panel = document.getElementById("terminal-panel")!;
const host = document.getElementById("terminal")!;
const title = document.getElementById("terminal-title")!;

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let running = false;
let sessionId = 0;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

function applyTheme() {
  if (!term) return;
  term.options.theme = {
    background: cssVar("--bg"),
    foreground: cssVar("--fg"),
    cursor: cssVar("--accent"),
    selectionBackground: cssVar("--hover"),
  };
}

function decode(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function fitNow() {
  if (!term || !fit || panel.hidden) return;
  fit.fit();
  void invoke("term_resize", { rows: term.rows, cols: term.cols }).catch(
    () => undefined,
  );
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
  if (term) {
    term.options.fontSize = fontSize;
    fitNow();
  }
  try {
    localStorage.setItem("terminalFontSize", String(fontSize));
  } catch {
    // storage unavailable: font size not remembered
  }
}

async function create() {
  term = new Terminal({
    fontFamily: cssVar("--font-mono") || "monospace",
    fontSize,
    cursorBlink: true,
    scrollback: 5000,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  // Copia alla selezione, incolla con la rotella: selezione PRIMARY, condivisa con gli altri terminali
  term.onSelectionChange(() => {
    const text = term!.getSelection();
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
      .then((text) => text && term!.paste(text))
      .catch(() => undefined);
  });
  term.onData(
    (data) => void invoke("term_write", { data }).catch(() => undefined),
  );
  await listen<string>("term-data", (event) =>
    term?.write(decode(event.payload)),
  );
  await listen<number>("term-exit", (event) => {
    if (event.payload !== sessionId) return;
    running = false;
    hideTerminal();
  });
  new ResizeObserver(fitNow).observe(host);
}

async function start(cwd: string | null) {
  fitNow();
  term!.reset();
  await invoke("term_start", { cwd, rows: term!.rows, cols: term!.cols });
  sessionId = await invoke<number>("term_session");
  running = true;
  title.textContent = cwd ?? "Terminal";
  title.title = cwd ?? "";
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

/** Pastes dropped file paths into the shell, quoted when they contain special characters. */
export function pasteFilePaths(paths: string[]) {
  const quoted = paths.map((path) =>
    /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`,
  );
  term?.paste(`${quoted.join(" ")} `);
  term?.focus();
}

export function writeToTerminal(data: string) {
  void invoke("term_write", { data }).catch(() => undefined);
}

export function hideTerminal() {
  panel.hidden = true;
}

/** Shows the terminal; the shell starts in `cwd` the first time (and again after it exited). */
export async function showTerminal(cwd: string | null) {
  panel.hidden = false;
  if (!term) await create();
  applyTheme();
  fitNow();
  if (!running) await start(cwd);
  term!.focus();
}

/** Ends the current shell and starts a new one in `cwd`. */
export async function restartTerminal(cwd: string | null) {
  panel.hidden = false;
  if (!term) await create();
  applyTheme();
  running = false;
  await invoke("term_stop");
  await start(cwd);
  term!.focus();
}

document
  .getElementById("terminal-hide")!
  .addEventListener("click", hideTerminal);

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

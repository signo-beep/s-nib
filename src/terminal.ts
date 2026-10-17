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

async function create() {
  term = new Terminal({
    fontFamily: cssVar("--font-mono") || "monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
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

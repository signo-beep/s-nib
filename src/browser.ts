import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { showToast } from "./toast";

const toggle = document.getElementById("browser-toggle")!;

/** Last cell of the terminal grid: a native child webview is laid over its host element. */
let cell: HTMLElement | null = null;
let host: HTMLElement | null = null;
let address: HTMLInputElement | null = null;
let observer: ResizeObserver | null = null;
let shown = false;
let listening = false;
let onClose: () => void = () => undefined;
let onHidePanel: () => void = () => undefined;

export function browserOpen(): boolean {
  return cell !== null;
}

export function browserElement(): HTMLElement | null {
  return cell;
}

function setToggle(active: boolean) {
  toggle.classList.toggle("active", active);
  toggle.setAttribute("aria-pressed", String(active));
}

/** The host rectangle; never extends over the status bar (the native view floats above the whole window). */
function rect() {
  const box = host!.getBoundingClientRect();
  const limit =
    document.getElementById("statusbar")?.getBoundingClientRect().top ??
    window.innerHeight;
  return {
    x: box.left,
    y: box.top,
    width: box.width,
    height: Math.max(1, Math.min(box.height, limit - box.top)),
  };
}

let settleTimer = 0;

/** Moves the native view onto the host element; call after anything that changes the layout. */
export function syncBrowser() {
  if (!host || !shown) return;
  void invoke("browser_bounds", rect()).catch(() => undefined);
  // the layout may still move after this call: place the view once more when it has settled
  clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    if (host && shown) void invoke("browser_bounds", rect()).catch(() => undefined);
  }, 150);
}

/** Shows or hides the native view with the panel (it floats above the page, so CSS `hidden` is not enough). */
export function setBrowserShown(visible: boolean) {
  shown = visible;
  if (!cell) return;
  if (visible)
    void invoke("browser_show", { url: null, ...rect() }).catch(() => undefined);
  else void invoke("browser_hide").catch(() => undefined);
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

async function go() {
  if (!address) return;
  try {
    address.value = await invoke<string>("browser_go", { url: address.value });
  } catch (error) {
    showToast(String(error), "error");
  }
}

async function listenOnce() {
  if (listening) return;
  listening = true;
  await listen<{ url: string }>("browser-url", (event) => {
    if (address && document.activeElement !== address)
      address.value = event.payload.url === "about:blank" ? "" : event.payload.url;
  });
  await listen<{ title: string }>("browser-title", (event) => {
    if (address) address.title = event.payload.title;
  });
}

/**
 * Appends the browser cell to `grid` and opens the native view. `close` runs after the cell is removed,
 * `hidePanel` when the user hides the panel from the cell's bar.
 */
export async function openBrowser(
  grid: HTMLElement,
  callbacks: { close: () => void; hidePanel: () => void },
  url = "about:blank",
): Promise<HTMLElement> {
  if (cell) return cell;
  onClose = callbacks.close;
  onHidePanel = callbacks.hidePanel;
  await listenOnce();

  const el = document.createElement("div");
  el.className = "terminal-cell browser-cell";
  const bar = document.createElement("div");
  bar.className = "terminal-bar browser-bar";
  const back = makeButton("Back", "←", "browser-back");
  const forward = makeButton("Forward", "→", "browser-forward");
  const reload = makeButton("Reload", "↻", "browser-reload");
  const input = document.createElement("input");
  input.className = "browser-address";
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.placeholder = "Address";
  input.setAttribute("aria-label", "Address");
  const hide = makeButton("Hide panel (Ctrl+Shift+T)", "▾", "terminal-hide");
  const close = makeButton("Close browser", "✕", "terminal-close");
  bar.append(back, forward, reload, input, hide, close);
  const hostEl = document.createElement("div");
  hostEl.className = "browser-host";
  el.append(bar, hostEl);
  grid.append(el);

  cell = el;
  host = hostEl;
  address = input;
  shown = true;
  setToggle(true);

  back.addEventListener("click", () => void invoke("browser_nav", { action: "back" }));
  forward.addEventListener("click", () => void invoke("browser_nav", { action: "forward" }));
  reload.addEventListener("click", () => void invoke("browser_nav", { action: "reload" }));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void go();
    } else if (event.key === "Escape") input.blur();
  });
  input.addEventListener("focus", () => input.select());
  hide.addEventListener("click", () => onHidePanel());
  close.addEventListener("click", closeBrowser);

  observer = new ResizeObserver(syncBrowser);
  observer.observe(hostEl);
  // anything that moves the panel without resizing the cell
  observer.observe(document.body);
  const panel = document.getElementById("terminal-panel");
  if (panel) observer.observe(panel);

  try {
    await invoke("browser_show", {
      url: url === "about:blank" ? null : url,
      ...rect(),
    });
  } catch (error) {
    showToast(String(error), "error");
    closeBrowser();
    return el;
  }
  if (url !== "about:blank") input.value = url;
  else input.focus();
  return el;
}

/** Removes the cell and destroys the native view (the page is lost). */
export function closeBrowser() {
  if (!cell) return;
  observer?.disconnect();
  observer = null;
  cell.remove();
  cell = null;
  host = null;
  address = null;
  setToggle(false);
  void invoke("browser_close").catch(() => undefined);
  onClose();
}

window.addEventListener("resize", syncBrowser);

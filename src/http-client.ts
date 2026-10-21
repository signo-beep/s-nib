import type { EditorView } from "@milkdown/kit/prose/view";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { syncBrowser } from "./browser";
import {
  fileVariables,
  requestAt,
  resolveRequest,
  type ResolveContext,
  type StoredResponse,
} from "./http-request";
import { showToast } from "./toast";

interface HttpResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  binary: boolean;
  truncated: boolean;
  size: number;
  millis: number;
}

interface HistoryItem {
  label: string;
  response: HttpResponse;
  request: string;
}

const HTTP_LANGUAGES = new Set(["http"]);
const SHARED_ENV = "$shared";
const HISTORY_KEEP = 30;
const NO_ENV = "";

const panel = document.getElementById("http-panel")!;
const summary = document.getElementById("http-summary")!;
const envSelect = document.getElementById("http-env") as HTMLSelectElement;
const historySelect = document.getElementById("http-history") as HTMLSelectElement;
const output = document.getElementById("http-output")!;
const tabButtons = panel.querySelectorAll<HTMLButtonElement>("[data-http-tab]");

let documentPath: () => string | null = () => null;

/** Lets the client find the `.env` next to the active document. */
export function setHttpDocumentPath(provider: () => string | null) {
  documentPath = provider;
}

const responses = new Map<string, StoredResponse>();
const history: HistoryItem[] = [];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_SHOWN_URL = 300;
/** Hosts the user approved during this session. */
const trustedHosts = new Set<string>();
let environments: Record<string, Record<string, string>> = {};
let tab: "body" | "headers" = "body";
let shown: HistoryItem | null = null;

function setPanelHidden(hidden: boolean) {
  panel.hidden = hidden;
  syncBrowser();
}

/** Language of the code block holding the cursor, or null outside code blocks. */
function blockLanguage(view: EditorView): string | null {
  const { parent } = view.state.selection.$from;
  return parent.type.name === "code_block"
    ? String(parent.attrs.language ?? "").toLowerCase()
    : null;
}

export function inHttpBlock(view: EditorView): boolean {
  return HTTP_LANGUAGES.has(blockLanguage(view) ?? "");
}

/** Every http block of the document: `@name = value` lines in any of them are file variables. */
function documentHttpText(view: EditorView): string {
  const parts: string[] = [];
  view.state.doc.descendants((node) => {
    if (
      node.type.name === "code_block" &&
      HTTP_LANGUAGES.has(String(node.attrs.language ?? "").toLowerCase())
    )
      parts.push(node.textContent);
    return node.type.name !== "code_block";
  });
  return parts.join("\n");
}

async function loadEnvironments() {
  try {
    const parsed: unknown = JSON.parse(await invoke<string>("http_env"));
    environments =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, Record<string, string>>)
        : {};
  } catch (error) {
    environments = {};
    showToast(`http-env.json: ${String(error)}`, "error");
  }
  const names = Object.keys(environments).filter((name) => name !== SHARED_ENV);
  let saved = NO_ENV;
  try {
    saved = localStorage.getItem("httpEnv") ?? NO_ENV;
  } catch {
    // storage unavailable: no remembered environment
  }
  envSelect.replaceChildren(
    new Option("No environment", NO_ENV),
    ...names.map((name) => new Option(name, name)),
  );
  envSelect.value = names.includes(saved) ? saved : NO_ENV;
}

function environmentVariables(): Record<string, string> {
  return {
    ...(environments[SHARED_ENV] ?? {}),
    ...(envSelect.value ? (environments[envSelect.value] ?? {}) : {}),
  };
}

function formatBody(response: HttpResponse): string {
  if (response.binary) return `(binary content, ${response.size} bytes)`;
  const type =
    response.headers.find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? "";
  if (type.includes("json") || /^\s*[{[]/.test(response.body)) {
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      // not JSON after all: show it as received
    }
  }
  return response.body;
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function render() {
  for (const button of tabButtons)
    button.classList.toggle("active", button.dataset.httpTab === tab);
  if (!shown) {
    summary.textContent = "No request sent yet";
    summary.className = "";
    output.textContent = "";
    return;
  }
  const { response } = shown;
  summary.textContent =
    `${response.status} ${response.statusText} · ${response.millis} ms · ${formatSize(response.size)}` +
    (response.truncated ? " (truncated)" : "");
  summary.className = response.status >= 400 ? "http-bad" : "http-ok";
  output.textContent =
    tab === "body"
      ? formatBody(response)
      : response.headers.map(([key, value]) => `${key}: ${value}`).join("\n");
}

function refreshHistory() {
  historySelect.replaceChildren(
    ...history.map((item, index) => new Option(item.label, String(index))),
  );
  historySelect.value = String(history.indexOf(shown as HistoryItem));
}

/**
 * Asks before a request goes out, unless the host was approved in this session. Reading from the machine
 * itself is the only case that never asks; a request that carries secrets from `.env` or the environment
 * always needs an approved host, loopback included.
 */
async function confirmSend(
  method: string,
  url: string,
  usesSecrets: boolean,
): Promise<boolean> {
  const { host, hostname } = new URL(url);
  const safeLocalRead = LOOPBACK_HOSTS.has(hostname) && SAFE_METHODS.has(method);
  if (trustedHosts.has(host) || (safeLocalRead && !usesSecrets)) return true;
  const shown = url.length > MAX_SHOWN_URL ? `${url.slice(0, MAX_SHOWN_URL)}...` : url;
  const ok = await ask(
    `Send this request?\n\n${method} ${shown}` +
      (usesSecrets ? "\n\nIt contains values read from .env or the environment." : ""),
    { title: "s-nib", kind: "warning", okLabel: "Send", cancelLabel: "Cancel" },
  );
  if (ok) trustedHosts.add(host);
  return ok;
}

async function send(view: EditorView) {
  const { $from } = view.state.selection;
  const upToCursor = $from.parent.textBetween(0, $from.parentOffset);
  const line = upToCursor.split("\n").length - 1;
  const block = $from.parent.textContent;
  const request = requestAt(block, line);
  if (!request) throw new Error("no request at the cursor");

  const context: ResolveContext = {
    fileVars: fileVariables(documentHttpText(view)),
    envVars: environmentVariables(),
    responses,
    processEnv: (name) => invoke<string>("http_process_env", { name }),
    dotenv: (name) => {
      const path = documentPath();
      const folder = path ? path.replace(/[\\/][^\\/]*$/, "") : "";
      return invoke<string>("http_dotenv", { folder, name });
    },
  };
  const resolved = await resolveRequest(request, context);
  if (!(await confirmSend(resolved.method, resolved.url, context.usedSecrets === true)))
    return;

  setPanelHidden(false);
  summary.textContent = `${resolved.method} ${resolved.url} ...`;
  summary.className = "";
  const response = await invoke<HttpResponse>("http_send", {
    request: {
      method: resolved.method,
      url: resolved.url,
      headers: resolved.headers,
      body: resolved.body || null,
    },
  });
  if (request.name)
    responses.set(request.name, { headers: response.headers, body: response.body });
  const item: HistoryItem = {
    label: `${response.status} ${resolved.method} ${resolved.url}`,
    response,
    request: `${resolved.method} ${resolved.url}`,
  };
  history.unshift(item);
  history.length = Math.min(history.length, HISTORY_KEEP);
  shown = item;
  refreshHistory();
  render();
}

/** Sends the request under the cursor (Ctrl+Alt+R in an `http` block, context menu, palette). */
export async function sendRequest(view: EditorView) {
  if (!inHttpBlock(view)) {
    showToast("Put the cursor in an http code block", "error");
    return;
  }
  try {
    await send(view);
  } catch (error) {
    summary.textContent = "Request failed";
    summary.className = "http-bad";
    showToast(error instanceof Error ? error.message : String(error), "error");
  }
}

/** Shows the response panel (environment and history pickers) without sending anything. */
export function showHttpPanel() {
  setPanelHidden(false);
  void loadEnvironments();
  render();
}

for (const button of tabButtons)
  button.addEventListener("click", () => {
    tab = button.dataset.httpTab === "headers" ? "headers" : "body";
    render();
  });
envSelect.addEventListener("change", () => {
  try {
    localStorage.setItem("httpEnv", envSelect.value);
  } catch {
    // storage unavailable: environment not remembered
  }
});
historySelect.addEventListener("change", () => {
  shown = history[Number(historySelect.value)] ?? null;
  render();
});
document.getElementById("http-copy")!.addEventListener("click", () => {
  const text = output.textContent ?? "";
  if (text)
    void invoke("clipboard_set", { text }).catch((error: unknown) =>
      showToast(String(error), "error"),
    );
});
document
  .getElementById("http-close")!
  .addEventListener("click", () => setPanelHidden(true));
void loadEnvironments();
render();

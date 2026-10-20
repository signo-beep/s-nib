import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { showContextMenu } from "./context-menu";
import { exportHtml } from "./export";
import { exportPdf } from "./pdf-export";
import { addSidebarTab, showSidebarTab } from "./sidebar";
import {
  type DocSource,
  SourceConflict,
  openRemote,
  registerSource,
} from "./sources";
import { showToast } from "./toast";

/** Optional MariaDB connector (Rust feature `db`): documents are rows of tables set up in `databases.toml`. */

interface ConnectionInfo {
  name: string;
  write: boolean;
  tables: string[];
}

interface DbRow {
  id: string;
  label: string;
  /** Header the row is listed under (e.g. the course), null when the table has no group. */
  group: string | null;
}

interface DbDocument {
  text: string;
  version: string;
  label: string;
}

const KIND = "db";
const SEARCH_DELAY = 250;
/** Rows per page, as returned by the backend. */
const PAGE_SIZE = 100;

/** Document key: connection, table and row id. */
function makeKey(connection: string, table: string, id: string): string {
  return JSON.stringify([connection, table, id]);
}

function parseKey(key: string): [string, string, string] {
  return JSON.parse(key) as [string, string, string];
}

/** Rows that came with CRLF line ends: the editor works with LF, so the text is converted back on save. */
const crlfKeys = new Set<string>();

/** Password dialog; null when cancelled. `retry`: the previous password was refused. */
function askPassword(connection: string, retry: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "app-dialog";
    dialog.id = "db-password-dialog";
    const form = document.createElement("form");
    form.method = "dialog";
    const title = document.createElement("h2");
    title.textContent = `Password for ${connection}`;
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Password");
    const hint = document.createElement("p");
    hint.className = "folder-search-status";
    hint.textContent = retry
      ? "Wrong password, try again."
      : "Stored in the system keyring.";
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.type = "submit";
    ok.textContent = "Connect";
    actions.append(cancel, ok);
    form.append(title, input, hint, actions);
    dialog.append(form);
    document.body.append(dialog);
    let value: string | null = null;
    cancel.addEventListener("click", () => dialog.close());
    form.addEventListener("submit", () => {
      value = input.value || null;
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(value);
    });
    dialog.showModal();
    input.focus();
  });
}

/** Runs a backend command; asks for the password until the server accepts it (or the dialog is cancelled). */
async function call<T>(
  connection: string,
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  let refused = false;
  for (;;) {
    try {
      return await invoke<T>(command, { connection, ...args });
    } catch (error) {
      const message = String(error);
      if (message.startsWith("bad-password")) refused = true;
      else if (!message.startsWith("no-password")) throw error;
    }
    const password = await askPassword(connection, refused);
    if (!password) throw new Error("No password given");
    await invoke("db_set_password", { connection, password });
  }
}

const source: DocSource = {
  kind: KIND,
  async read(key) {
    const [connection, table, id] = parseKey(key);
    const doc = await call<DbDocument>(connection, "db_read", { table, id });
    if (doc.text.includes("\r\n")) crlfKeys.add(key);
    else crlfKeys.delete(key);
    return { ...doc, label: `${table}: ${doc.label}` };
  },
  async write(key, text, version) {
    const [connection, table, id] = parseKey(key);
    const content = crlfKeys.has(key) ? text.replace(/\r?\n/g, "\r\n") : text;
    try {
      return await call<string>(connection, "db_write", {
        table,
        id,
        text: content,
        version,
      });
    } catch (error) {
      if (String(error).startsWith("conflict")) throw new SourceConflict(String(error));
      throw error;
    }
  },
};

/** File name proposed for a row: its label without characters filesystems reject. */
export function fileNameOf(label: string) {
  return label.replace(/[\\/:*?"<>|\s]+/g, " ").trim().slice(0, 80) || "untitled";
}

/** Writes the document `key` to a local Markdown file chosen by the user. */
async function saveLocalCopy(key: string, label: string) {
  const target = await save({
    filters: [{ name: "Markdown", extensions: ["md"] }],
    defaultPath: `${fileNameOf(label)}.md`,
  });
  if (!target) return;
  try {
    const doc = await source.read(key);
    await invoke("write_text_file", { path: target, content: doc.text });
    showToast("Saved");
  } catch (error) {
    showToast(String(error), "error");
  }
}

/** Converts the document `key` straight from the database, without opening a pane. */
async function exportRow(key: string, label: string, format: "html" | "pdf") {
  try {
    const doc = await source.read(key);
    const name = fileNameOf(label);
    if (format === "html") await exportHtml(doc.text, null, name);
    else await exportPdf(doc.text, null, name);
  } catch (error) {
    showToast(String(error), "error");
  }
}

/** Panel with connection, table, search and the row list. */
function buildPanel(panel: HTMLElement, connections: ConnectionInfo[]) {
  const bar = document.createElement("div");
  bar.className = "db-bar";
  const connectionSelect = document.createElement("select");
  connectionSelect.setAttribute("aria-label", "Connection");
  const tableSelect = document.createElement("select");
  tableSelect.setAttribute("aria-label", "Table");
  const search = document.createElement("input");
  search.type = "text";
  search.placeholder = "Search";
  search.setAttribute("aria-label", "Search documents");
  search.spellcheck = false;
  search.autocomplete = "off";
  const selects = document.createElement("div");
  selects.className = "db-selects";
  selects.append(connectionSelect, tableSelect);
  bar.append(selects, search);
  const status = document.createElement("p");
  status.className = "folder-search-status";
  const list = document.createElement("ul");
  list.className = "tree";
  const more = document.createElement("button");
  more.type = "button";
  more.className = "db-more";
  more.textContent = "More";
  more.hidden = true;
  panel.append(bar, status, list, more);

  connectionSelect.replaceChildren(
    ...connections.map((c) => new Option(c.name, c.name)),
  );

  let offset = 0;
  let generation = 0;
  /** Group of the last row listed, so a page continues under the right header. */
  let lastGroup: string | null = null;

  const current = () =>
    connections.find((c) => c.name === connectionSelect.value);

  function fillTables() {
    tableSelect.replaceChildren(
      ...(current()?.tables ?? []).map((t) => new Option(t, t)),
    );
  }

  async function load(reset: boolean) {
    const connection = current();
    if (!connection || !tableSelect.value) {
      list.replaceChildren();
      status.textContent = connection ? "No tables configured" : "";
      more.hidden = true;
      return;
    }
    if (reset) {
      offset = 0;
      lastGroup = null;
    }
    const mine = ++generation;
    status.textContent = "Loading...";
    let rows: DbRow[];
    try {
      rows = await call<DbRow[]>(connection.name, "db_rows", {
        table: tableSelect.value,
        query: search.value.trim(),
        offset,
      });
    } catch (error) {
      if (mine !== generation) return;
      list.replaceChildren();
      more.hidden = true;
      status.textContent = String(error);
      return;
    }
    if (mine !== generation) return;
    const items = rows.flatMap((row) => {
      const entries: HTMLLIElement[] = [];
      if (row.group !== null && row.group !== lastGroup) {
        const header = document.createElement("li");
        header.className = "db-group";
        header.textContent = row.group;
        entries.push(header);
      }
      lastGroup = row.group;
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tree-item";
      button.textContent = row.label;
      button.title = row.label;
      button.addEventListener("click", (event) => {
        void openRemote(
          KIND,
          makeKey(connection.name, tableSelect.value, row.id),
          event.ctrlKey || event.metaKey,
        );
      });
      const key = makeKey(connection.name, tableSelect.value, row.id);
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        showContextMenu(
          [
            { label: "Save as local file...", run: () => saveLocalCopy(key, row.label) },
            { label: "Export as HTML...", run: () => exportRow(key, row.label, "html") },
            { label: "Export as PDF...", run: () => exportRow(key, row.label, "pdf") },
          ],
          event.clientX,
          event.clientY,
        );
      });
      item.append(button);
      entries.push(item);
      return entries;
    });
    if (reset) list.replaceChildren(...items);
    else list.append(...items);
    offset += rows.length;
    more.hidden = rows.length < PAGE_SIZE;
    status.textContent = connection.write
      ? `${offset} documents`
      : `${offset} documents (read only)`;
  }

  let timer: number | undefined;
  search.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void load(true), SEARCH_DELAY);
  });
  connectionSelect.addEventListener("change", () => {
    fillTables();
    void load(true);
  });
  tableSelect.addEventListener("change", () => void load(true));
  more.addEventListener("click", () => void load(false));

  fillTables();
  return () => void load(true);
}

/**
 * Adds the "Database" tab when the app was built with the connector and the config has connections.
 * `onReady` receives the palette entry for the tab.
 */
export async function initDatabase(
  onReady: (action: string, label: string, show: () => void) => void,
) {
  let connections: ConnectionInfo[];
  try {
    connections = await invoke<ConnectionInfo[]>("db_connections");
  } catch (error) {
    // a build without the `db` feature has no such command; a broken config is worth a hint
    if (!String(error).includes("not found")) console.warn("s-nib database:", error);
    return;
  }
  if (!connections.length) return;
  registerSource(source);
  let refresh: (() => void) | undefined;
  const panel = addSidebarTab("database", "Database", () => refresh?.());
  refresh = buildPanel(panel, connections);
  onReady("show_database", "View: Database", () => showSidebarTab("database"));
}

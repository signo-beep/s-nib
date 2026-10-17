import { invoke } from "@tauri-apps/api/core";
import { renderDocumentHtml } from "./export";
import { splitFrontMatter } from "./frontmatter";

interface HistoryEntry {
  id: number;
  size: number;
}

const dialog = document.getElementById("history-dialog") as HTMLDialogElement;
const list = document.getElementById("history-list") as HTMLUListElement;
const preview = document.getElementById("history-preview") as HTMLIFrameElement;
const source = document.getElementById("history-source") as HTMLTextAreaElement;
const sourceToggle = document.getElementById(
  "history-source-toggle",
) as HTMLButtonElement;
const status = document.getElementById("history-status")!;
const restoreButton = document.getElementById(
  "history-restore",
) as HTMLButtonElement;
let selected: string | null = null;

document
  .getElementById("history-close")!
  .addEventListener("click", () => dialog.close());
sourceToggle.addEventListener("click", () => {
  const showSource = source.hidden;
  source.hidden = !showSource;
  preview.hidden = showSource;
  sourceToggle.textContent = showSource ? "Show preview" : "Show source";
});

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Saved versions of a document (a copy every few minutes, up to 30); Restore puts one back as an unsaved change. */
export async function openHistory(
  path: string,
  restore: (content: string) => void,
) {
  const entries = await invoke<HistoryEntry[]>("history_list", { path });
  list.replaceChildren();
  preview.srcdoc = "";
  source.value = "";
  source.hidden = true;
  preview.hidden = false;
  sourceToggle.textContent = "Show source";
  sourceToggle.disabled = true;
  restoreButton.disabled = true;
  selected = null;
  status.textContent = entries.length
    ? "Select a version to preview it."
    : "No saved versions yet: a copy is kept when the file is saved.";

  for (const entry of entries) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${new Date(entry.id).toLocaleString()} (${formatSize(entry.size)})`;
    button.addEventListener("click", async () => {
      list
        .querySelectorAll("button")
        .forEach((other) => other.removeAttribute("aria-current"));
      button.setAttribute("aria-current", "true");
      try {
        const text = await invoke<string>("history_read", {
          path,
          id: entry.id,
        });
        selected = text;
        source.value = text;
        preview.srcdoc = await renderDocumentHtml(
          splitFrontMatter(text).body,
          path,
        );
        restoreButton.disabled = false;
        sourceToggle.disabled = false;
      } catch (error) {
        status.textContent = String(error);
      }
    });
    item.append(button);
    list.append(item);
  }

  restoreButton.onclick = () => {
    if (selected === null) return;
    dialog.close();
    restore(selected);
  };
  dialog.showModal();
}

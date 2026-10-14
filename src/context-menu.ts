import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import {
  createCodeBlockCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleStrongCommand,
  turnIntoTextCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from "@milkdown/kit/preset/commonmark";
import { toggleStrikethroughCommand } from "@milkdown/kit/preset/gfm";
import { callCommand } from "@milkdown/kit/utils";
import { ALERT_TYPES, currentAlert, setAlert, type AlertType } from "./alerts";
import { showToast } from "./toast";

interface Item {
  label: string;
  hint?: string;
  alert?: AlertType;
  run: () => void | Promise<void>;
}

type Entry = Item | Item[] | "separator";

const ALERT_LABELS: Record<AlertType, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

const menuEl = document.getElementById("context-menu")!;

function close() {
  menuEl.hidden = true;
  menuEl.replaceChildren();
}

function button(item: Item, className = ""): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  if (item.alert) el.dataset.alert = item.alert;
  const label = document.createElement("span");
  label.textContent = item.label;
  el.append(label);
  if (item.hint) {
    const hint = document.createElement("kbd");
    hint.textContent = item.hint;
    el.append(hint);
  }
  el.addEventListener("click", () => {
    close();
    void Promise.resolve(item.run()).catch((error: unknown) => showToast(String(error), "error"));
  });
  return el;
}

async function paste(editor: Editor) {
  const text = await navigator.clipboard.readText();
  editor.action((ctx) => ctx.get(editorViewCtx).pasteText(text));
}

function buildEntries(editor: Editor): Entry[] {
  const command = (run: ReturnType<typeof callCommand>) => () => {
    editor.action(run);
    editor.action((ctx) => ctx.get(editorViewCtx).focus());
  };
  const getView = () => editor.action((ctx) => ctx.get(editorViewCtx));
  const active = currentAlert(getView());
  const inQuote = (() => {
    const { $from } = getView().state.selection;
    for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.name === "blockquote") return true;
    return false;
  })();

  const entries: Entry[] = [
    [
      { label: "Cut", hint: "Ctrl+X", run: () => void document.execCommand("cut") },
      { label: "Copy", hint: "Ctrl+C", run: () => void document.execCommand("copy") },
      { label: "Paste", hint: "Ctrl+V", run: () => paste(editor) },
    ],
    "separator",
    { label: "Bold", hint: "Ctrl+B", run: command(callCommand(toggleStrongCommand.key)) },
    { label: "Italic", hint: "Ctrl+I", run: command(callCommand(toggleEmphasisCommand.key)) },
    { label: "Strikethrough", run: command(callCommand(toggleStrikethroughCommand.key)) },
    { label: "Inline code", run: command(callCommand(toggleInlineCodeCommand.key)) },
    "separator",
    { label: "Paragraph", run: command(callCommand(turnIntoTextCommand.key)) },
    [1, 2, 3, 4, 5, 6].map((level) => ({
      label: `H${level}`,
      run: command(callCommand(wrapInHeadingCommand.key, level)),
    })),
    { label: "Bulleted list", run: command(callCommand(wrapInBulletListCommand.key)) },
    { label: "Numbered list", run: command(callCommand(wrapInOrderedListCommand.key)) },
    { label: "Quote", run: command(callCommand(wrapInBlockquoteCommand.key)) },
    { label: "Code block", run: command(callCommand(createCodeBlockCommand.key)) },
    "separator",
    ...ALERT_TYPES.map((alert) => ({
      label: ALERT_LABELS[alert],
      alert,
      run: () => void setAlert(getView(), alert),
    })),
  ];
  if (inQuote && active) entries.push({ label: "Remove alert", run: () => void setAlert(getView(), null) });
  return entries;
}

function render(entries: Entry[]) {
  const nodes = entries.map((entry) => {
    if (entry === "separator") {
      const hr = document.createElement("hr");
      return hr;
    }
    if (Array.isArray(entry)) {
      const row = document.createElement("div");
      row.className = "row";
      row.append(...entry.map((item) => button(item)));
      return row;
    }
    return button(entry);
  });
  menuEl.replaceChildren(...nodes);
}

function place(x: number, y: number) {
  menuEl.hidden = false;
  const { innerWidth, innerHeight } = window;
  const rect = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(4, Math.min(x, innerWidth - rect.width - 4))}px`;
  menuEl.style.top = `${Math.max(4, Math.min(y, innerHeight - rect.height - 4))}px`;
}

/** Right-click menu on the document: clipboard, text formatting, block type, alerts. */
export function initContextMenu(editor: Editor, editorEl: HTMLElement) {
  editorEl.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    render(buildEntries(editor));
    place(event.clientX, event.clientY);
  });
  // keep the editor selection while the menu is used
  menuEl.addEventListener("mousedown", (event) => event.preventDefault());
  document.addEventListener("pointerdown", (event) => {
    if (!menuEl.hidden && !(event.target as Element).closest("#context-menu")) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menuEl.hidden) close();
  });
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);
}

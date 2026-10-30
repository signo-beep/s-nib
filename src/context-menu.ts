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
import {
  addColAfterCommand,
  addColBeforeCommand,
  addRowAfterCommand,
  addRowBeforeCommand,
  setAlignCommand,
  toggleStrikethroughCommand,
} from "@milkdown/kit/preset/gfm";
import { invoke } from "@tauri-apps/api/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import {
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
} from "@milkdown/kit/prose/tables";
import { callCommand } from "@milkdown/kit/utils";
import { ALERT_TYPES, currentAlert, setAlert, type AlertType } from "./alerts";
import { insertPlainText } from "./editor-plugins";
import { inHttpBlock, sendRequest } from "./http-client";
import { showToast } from "./toast";

export interface Item {
  label: string;
  hint?: string;
  alert?: AlertType;
  run: () => void | Promise<void>;
}

interface Submenu {
  label: string;
  items: Entry[];
}

export type Entry = Item | Item[] | Submenu | { title: string } | "separator";

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
    void Promise.resolve(item.run()).catch((error: unknown) =>
      showToast(String(error), "error"),
    );
  });
  return el;
}

async function paste(editor: Editor) {
  let text = await invoke<string>("clipboard_get").catch(() => "");
  // arboard may not see a clipboard owned by a native Wayland client: ask the WebView as a fallback
  if (!text) text = await navigator.clipboard.readText().catch(() => "");
  if (!text) {
    showToast("Clipboard empty or unreadable", "error");
    return;
  }
  editor.action((ctx) => insertPlainText(ctx, ctx.get(editorViewCtx), text));
}

interface MisspelledWord {
  from: number;
  to: number;
  suggestions: string[];
}

/** Word under the click and its correction suggestions (empty list: correct, or no dictionary). */
async function findSuggestions(
  editor: Editor,
  event: MouseEvent,
  languages: string[],
): Promise<MisspelledWord | null> {
  if (!languages.length) return null;
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!hit) return null;
  const $pos = view.state.doc.resolve(hit.pos);
  if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) return null;
  const text = $pos.parent.textContent;
  const letter = /[\p{L}\p{M}]/u;
  let start = $pos.parentOffset;
  let end = start;
  while (start > 0 && letter.test(text[start - 1])) start--;
  while (end < text.length && letter.test(text[end])) end++;
  if (start === end) return null;
  const suggestions = await invoke<string[]>("spell_suggest", {
    word: text.slice(start, end),
    languages,
  });
  if (!suggestions.length) return null;
  const base = $pos.start();
  return { from: base + start, to: base + end, suggestions };
}

function buildEntries(
  editor: Editor,
  misspelled: MisspelledWord | null,
): Entry[] {
  const command = (run: ReturnType<typeof callCommand>) => () => {
    editor.action(run);
    editor.action((ctx) => ctx.get(editorViewCtx).focus());
  };
  const getView = () => editor.action((ctx) => ctx.get(editorViewCtx));
  const active = currentAlert(getView());
  const inQuote = (() => {
    const { $from } = getView().state.selection;
    for (let depth = $from.depth; depth > 0; depth--)
      if ($from.node(depth).type.name === "blockquote") return true;
    return false;
  })();

  const entries: Entry[] = [
    ...(misspelled
      ? ([
          { title: "Suggestions" },
          ...misspelled.suggestions.map((suggestion) => ({
            label: suggestion,
            run: () => {
              const view = getView();
              view.dispatch(
                view.state.tr.insertText(
                  suggestion,
                  misspelled.from,
                  misspelled.to,
                ),
              );
              view.focus();
            },
          })),
          "separator",
        ] as Entry[])
      : []),
    [
      {
        label: "Cut",
        hint: "Ctrl+X",
        run: () => void document.execCommand("cut"),
      },
      {
        label: "Copy",
        hint: "Ctrl+C",
        run: () => void document.execCommand("copy"),
      },
      { label: "Paste", hint: "Ctrl+V", run: () => paste(editor) },
    ],
    ...(inHttpBlock(getView())
      ? ([
          "separator",
          {
            label: "Send request",
            hint: "Ctrl+Alt+R",
            run: () => sendRequest(getView()),
          },
        ] as Entry[])
      : []),
    "separator",
    {
      label: "Bold",
      hint: "Ctrl+B",
      run: command(callCommand(toggleStrongCommand.key)),
    },
    {
      label: "Italic",
      hint: "Ctrl+I",
      run: command(callCommand(toggleEmphasisCommand.key)),
    },
    {
      label: "Strikethrough",
      run: command(callCommand(toggleStrikethroughCommand.key)),
    },
    {
      label: "Inline code",
      run: command(callCommand(toggleInlineCodeCommand.key)),
    },
    { title: "Block" },
    { label: "Paragraph", run: command(callCommand(turnIntoTextCommand.key)) },
    [1, 2, 3, 4, 5, 6].map((level) => ({
      label: `H${level}`,
      run: command(callCommand(wrapInHeadingCommand.key, level)),
    })),
    {
      label: "Bulleted list",
      run: command(callCommand(wrapInBulletListCommand.key)),
    },
    {
      label: "Numbered list",
      run: command(callCommand(wrapInOrderedListCommand.key)),
    },
    { label: "Quote", run: command(callCommand(wrapInBlockquoteCommand.key)) },
    {
      label: "Code block",
      run: command(callCommand(createCodeBlockCommand.key)),
    },
    { title: "Insert" },
  ];
  const alertItems: Entry[] = ALERT_TYPES.map((alert) => ({
    label: ALERT_LABELS[alert],
    alert,
    run: () => void setAlert(getView(), alert),
  }));
  if (inQuote && active)
    alertItems.push("separator", {
      label: "Remove alert",
      run: () => void setAlert(getView(), null),
    });
  entries.push({ label: "Alert", items: alertItems });
  if (isInTable(getView().state)) {
    const remove = (fn: typeof deleteRow) => () => {
      const view = getView();
      fn(view.state, view.dispatch);
      view.focus();
    };
    entries.push({
      label: "Table",
      items: [
        [
          {
            label: "Row above",
            run: command(callCommand(addRowBeforeCommand.key)),
          },
          {
            label: "Row below",
            run: command(callCommand(addRowAfterCommand.key)),
          },
        ],
        [
          {
            label: "Column left",
            run: command(callCommand(addColBeforeCommand.key)),
          },
          {
            label: "Column right",
            run: command(callCommand(addColAfterCommand.key)),
          },
        ],
        (["left", "center", "right"] as const).map((align) => ({
          label: `Align ${align}`,
          run: command(callCommand(setAlignCommand.key, align)),
        })),
        [
          { label: "Delete row", run: remove(deleteRow) },
          { label: "Delete column", run: remove(deleteColumn) },
          { label: "Delete table", run: remove(deleteTable) },
        ],
      ],
    });
  }
  return entries;
}

function node(entry: Entry): HTMLElement {
  if (entry === "separator") return document.createElement("hr");
  if ("title" in entry) {
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = entry.title;
    return title;
  }
  if (Array.isArray(entry)) {
    const row = document.createElement("div");
    row.className = "row";
    row.append(...entry.map((item) => button(item)));
    return row;
  }
  if ("items" in entry) return submenu(entry);
  return button(entry);
}

/** Entry with a flyout: fixed position, because the menu scrolls and would clip an absolute one. */
function submenu(entry: Submenu): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "sub";
  const trigger = document.createElement("button");
  trigger.type = "button";
  const label = document.createElement("span");
  label.textContent = entry.label;
  const arrow = document.createElement("kbd");
  arrow.textContent = ">";
  trigger.append(label, arrow);
  const flyout = document.createElement("div");
  flyout.className = "sub-menu";
  flyout.append(...entry.items.map(node));
  wrap.append(trigger, flyout);

  const open = () => {
    flyout.style.display = "block";
    const anchor = wrap.getBoundingClientRect();
    const size = flyout.getBoundingClientRect();
    const left =
      anchor.right + size.width + 4 > window.innerWidth
        ? anchor.left - size.width - 2
        : anchor.right - 2;
    flyout.style.left = `${Math.max(4, left)}px`;
    flyout.style.top = `${Math.max(4, Math.min(anchor.top - 4, window.innerHeight - size.height - 4))}px`;
  };
  const hide = () => {
    flyout.style.display = "";
  };
  wrap.addEventListener("mouseenter", open);
  wrap.addEventListener("mouseleave", hide);
  trigger.addEventListener("focus", open);
  trigger.addEventListener("click", open);
  return wrap;
}

function render(entries: Entry[]) {
  menuEl.replaceChildren(...entries.map(node));
}

function place(x: number, y: number) {
  menuEl.hidden = false;
  const { innerWidth, innerHeight } = window;
  const rect = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(4, Math.min(x, innerWidth - rect.width - 4))}px`;
  menuEl.style.top = `${Math.max(4, Math.min(y, innerHeight - rect.height - 4))}px`;
}

let globalsReady = false;

function initGlobals() {
  if (globalsReady) return;
  globalsReady = true;
  // keep the editor selection while the menu is used
  menuEl.addEventListener("mousedown", (event) => event.preventDefault());
  document.addEventListener("pointerdown", (event) => {
    if (!menuEl.hidden && !(event.target as Element).closest("#context-menu"))
      close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menuEl.hidden) close();
  });
  window.addEventListener("blur", close);
  window.addEventListener("resize", close);
}

/** Right-click inside a table puts the cursor in the clicked cell, so the table actions target it. */
function moveCursorToClick(editor: Editor, event: MouseEvent) {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    if (!view.state.selection.empty) return;
    const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
    if (!hit) return;
    const selection = TextSelection.near(view.state.doc.resolve(hit.pos));
    view.dispatch(view.state.tr.setSelection(selection));
  });
}

/** Opens the menu with the given entries at a screen position (used outside the editor, for example by the folder tree). */
export function showContextMenu(entries: Entry[], x: number, y: number) {
  initGlobals();
  render(entries);
  place(x, y);
}

/** Right-click menu on a document pane: clipboard, text formatting, block type, alerts, table rows/columns. */
export function initContextMenu(
  editor: Editor,
  editorEl: HTMLElement,
  getSpellLanguages: () => string[],
) {
  initGlobals();
  editorEl.addEventListener("contextmenu", async (event) => {
    event.preventDefault();
    try {
      // inside a code block there is nothing to correct
      const misspelled = (event.target as Element).closest(".cm-editor")
        ? null
        : await findSuggestions(editor, event, getSpellLanguages()).catch(
            () => null,
          );
      // inside a code block the CodeMirror selection must stay untouched
      if (!(event.target as Element).closest(".cm-editor"))
        moveCursorToClick(editor, event);
      render(buildEntries(editor, misspelled));
      place(event.clientX, event.clientY);
    } catch (error) {
      showToast(String(error), "error");
    }
  });
}

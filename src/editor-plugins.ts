import { $prose } from "@milkdown/kit/utils";
import { gapCursor } from "@milkdown/kit/prose/gapcursor";
import { parserCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { Slice, type Mark } from "@milkdown/kit/prose/model";
import { invoke } from "@tauri-apps/api/core";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from "@milkdown/kit/prose/state";
import {
  Decoration,
  DecorationSet,
  type EditorView,
} from "@milkdown/kit/prose/view";

const MARKERS: Record<string, [string, string]> = {
  strong: ["**", "**"],
  emphasis: ["*", "*"],
  inlineCode: ["`", "`"],
  strike_through: ["~~", "~~"],
};

function markerWidget(text: string, pos: number, side: number): Decoration {
  return Decoration.widget(
    pos,
    () => {
      const span = document.createElement("span");
      span.className = "syntax-marker";
      span.textContent = text;
      return span;
    },
    { side, key: `marker-${side}-${pos}-${text}` },
  );
}

/** Contiguous text range, in the current block, that carries the given mark. */
function markRange(
  state: EditorState,
  mark: Mark,
): { from: number; to: number } | null {
  const { $from } = state.selection;
  const start = $from.start();
  const runs: { from: number; to: number }[] = [];
  let current: { from: number; to: number } | null = null;
  $from.parent.forEach((node, offset) => {
    const from = start + offset;
    const to = from + node.nodeSize;
    if (node.marks.some((m) => m.eq(mark))) {
      if (current) current.to = to;
      else {
        current = { from, to };
        runs.push(current);
      }
    } else {
      current = null;
    }
  });
  return (
    runs.find((run) => $from.pos >= run.from && $from.pos <= run.to) ?? null
  );
}

function revealDecorations(state: EditorState): Decoration[] {
  const decorations: Decoration[] = [];
  const { $from } = state.selection;

  if ($from.parent.type.name === "heading") {
    const level = Number($from.parent.attrs.level) || 1;
    decorations.push(markerWidget(`${"#".repeat(level)} `, $from.start(), -1));
  }

  for (const mark of $from.marks()) {
    const name = mark.type.name;
    const range = markRange(state, mark);
    if (!range) continue;
    if (name === "link") {
      decorations.push(markerWidget("[", range.from, -1));
      decorations.push(
        markerWidget(`](${mark.attrs.href ?? ""})`, range.to, 1),
      );
    } else if (MARKERS[name]) {
      const [open, close] = MARKERS[name];
      decorations.push(markerWidget(open, range.from, -1));
      decorations.push(markerWidget(close, range.to, 1));
    }
  }
  return decorations;
}

function focusDecoration(state: EditorState): Decoration[] {
  const { $from } = state.selection;
  if ($from.depth < 1) return [];
  return [
    Decoration.node($from.before(1), $from.after(1), { class: "focus-block" }),
  ];
}

function keepCaretCentered(view: {
  state: EditorState;
  dom: Element;
  coordsAtPos(pos: number): { top: number };
}) {
  if (!document.body.classList.contains("typewriter")) return;
  const scroller = view.dom.closest(".pane-scroller");
  if (!scroller) return;
  try {
    const caret = view.coordsAtPos(view.state.selection.head);
    const box = scroller.getBoundingClientRect();
    scroller.scrollTop += caret.top - (box.top + box.height * 0.4);
  } catch {
    // position not rendered yet: ignore
  }
}

const editingKey = new PluginKey<boolean>("s-nib-editing-experience");
const MARKERS_META = "s-nib-markers";

function showMarkers(view: EditorView): boolean {
  if (editingKey.getState(view.state) === false)
    view.dispatch(
      view.state.tr.setMeta(MARKERS_META, true).setMeta("addToHistory", false),
    );
  return false;
}

/** After a document is loaded the cursor sits at the start: keep the syntax hidden until the user clicks or presses a key. */
export function hideSyntaxMarkers(view: EditorView) {
  view.dispatch(
    view.state.tr.setMeta(MARKERS_META, false).setMeta("addToHistory", false),
  );
}

/** Inline syntax visible under the cursor, active block for focus mode, typewriter mode. */
export const editingExperience = $prose(
  () =>
    new Plugin({
      key: editingKey,
      state: {
        init: () => true,
        apply: (tr, revealed) => tr.getMeta(MARKERS_META) ?? revealed,
      },
      props: {
        // only the user's own input brings the syntax back, not the focus or selection set while loading
        handleDOMEvents: {
          mousedown: (view) => showMarkers(view),
          keydown: (view) => showMarkers(view),
        },
        decorations(state) {
          return DecorationSet.create(state.doc, [
            ...(editingKey.getState(state) ? revealDecorations(state) : []),
            ...focusDecoration(state),
          ]);
        },
      },
      view: () => ({
        update(view, previous) {
          if (!view.hasFocus()) return;
          if (
            previous.selection.eq(view.state.selection) &&
            previous.doc.eq(view.state.doc)
          )
            return;
          keepCaretCentered(view);
        },
      }),
    }),
);

/** Cursor between adjacent blocks (image, diagram, code): lets you type before and after. */
export const gapCursorPlugin = $prose(() => gapCursor());

/** A backtick typed with a dead key arrives as a composition, which skips the input rules: apply the inline code rule afterwards. */
export const compositionInlineCode = $prose(
  () =>
    new Plugin({
      key: new PluginKey("s-nib-composition-inline-code"),
      props: {
        handleDOMEvents: {
          compositionend: (view) => {
            setTimeout(() => applyInlineCode(view), 0);
            return false;
          },
        },
      },
    }),
);

function applyInlineCode(view: EditorView) {
  const { state } = view;
  const codeMark = state.schema.marks.inlineCode;
  const { $from, empty } = state.selection;
  if (!codeMark || !empty || !$from.parent.isTextblock) return;
  if ($from.parent.type.spec.code) return;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const match = /`([^`]+)`$/.exec(before);
  if (!match) return;
  const end = $from.pos;
  const start = end - match[0].length;
  const textStart = start + 1;
  const textEnd = end - 1;
  if (state.doc.rangeHasMark(start, end, codeMark)) return;
  const tr = state.tr
    .delete(textEnd, end)
    .delete(start, textStart)
    .addMark(start, start + match[1].length, codeMark.create())
    .removeStoredMark(codeMark);
  view.dispatch(tr);
}

const MARKDOWN_LINE = /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|~~~|\|.*\|\s*$)/m;

/** Multi-line plain text that does not look like Markdown (terminal output, source code) goes in as a code block: paragraphs would lose the indentation. */
export function pasteMultilineAsCode(view: EditorView, text: string): boolean {
  const body = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const codeBlock = view.state.schema.nodes.code_block;
  if (!codeBlock || !body.includes("\n") || MARKDOWN_LINE.test(body))
    return false;
  if (view.state.selection.$from.parent.type.spec.code) return false;
  view.dispatch(
    view.state.tr
      .replaceSelectionWith(codeBlock.create(null, view.state.schema.text(body)))
      .scrollIntoView(),
  );
  return true;
}

/** Single entry point for plain-text paste (Ctrl+V, middle click, context menu): same result whatever the source. */
export function insertPlainText(ctx: Ctx, view: EditorView, text: string) {
  const code = document.activeElement?.closest(".cm-editor");
  // a code block holds its own CodeMirror selection: insert there, not through ProseMirror
  if (code) document.execCommand("insertText", false, text);
  else if (!pasteMultilineAsCode(view, text)) {
    // parsed here as Markdown: view.pasteText gives Milkdown no clipboardData, so the text would go in literally and be escaped on save
    const doc = ctx.get(parserCtx)(text);
    if (typeof doc === "string") return;
    view.dispatch(
      view.state.tr.replaceSelection(Slice.maxOpen(doc.content)).scrollIntoView(),
    );
  }
}

const MIDDLE_PASTE_WINDOW_MS = 500;

/** WebKit also pastes by itself on a middle click, and CodeMirror handles that paste inside the code blocks: swallow it in the capture phase, so only the PRIMARY paste done through Rust remains. */
export function suppressNativeMiddleClickPaste(root: HTMLElement) {
  let lastMiddleClick = 0;
  const note = (event: Event) => {
    if ((event as MouseEvent).button === 1) lastMiddleClick = Date.now();
  };
  for (const type of ["mousedown", "mouseup", "auxclick"])
    root.addEventListener(type, note, true);
  const swallow = (event: Event) => {
    if (Date.now() - lastMiddleClick > MIDDLE_PASTE_WINDOW_MS) return;
    event.preventDefault();
    event.stopPropagation();
  };
  root.addEventListener("paste", swallow, true);
  // CodeMirror reads the text from the input event: the native paste can reach it without a paste event
  root.addEventListener(
    "beforeinput",
    (event) => {
      if (/^insertFromPaste/.test((event as InputEvent).inputType)) swallow(event);
    },
    true,
  );
}

/** Middle click pastes the PRIMARY selection through Rust: WebKit's own paste does not reach the code block rule. */
export const pasteAsCodeBlock = $prose((ctx) => {
  let middleClickAt = 0;
  const inCodeMirror = (event: Event) =>
    (event.target as Element).closest?.(".cm-editor");
  return new Plugin({
    key: new PluginKey("s-nib-paste-as-code-block"),
    props: {
      handleDOMEvents: {
        mousedown: (_view, event) => {
          if ((event as MouseEvent).button === 1) middleClickAt = Date.now();
          return false;
        },
        paste: (view, event) => {
          // the native paste of a middle click: auxclick below does it from PRIMARY
          if (Date.now() - middleClickAt < 500) {
            event.preventDefault();
            return true;
          }
          const data = (event as ClipboardEvent).clipboardData;
          if (!data || data.types.includes("text/html")) return false;
          if (inCodeMirror(event)) return false;
          const text = data.getData("text/plain");
          if (!text || !pasteMultilineAsCode(view, text)) return false;
          event.preventDefault();
          return true;
        },
        auxclick: (view, event) => {
          const click = event as MouseEvent;
          if (click.button !== 1) return false;
          event.preventDefault();
          const hit = view.posAtCoords({ left: click.clientX, top: click.clientY });
          const code = (event.target as Element).closest(".cm-editor");
          // in a code block the text goes at the CodeMirror cursor
          if (code) code.querySelector<HTMLElement>(".cm-content")?.focus();
          else if (hit)
            view.dispatch(
              view.state.tr.setSelection(
                TextSelection.near(view.state.doc.resolve(hit.pos)),
              ),
            );
          void invoke<string>("primary_get")
            .then((text) => {
              if (text) insertPlainText(ctx, view, text);
            })
            .catch(() => undefined);
          return true;
        },
      },
    },
  });
});

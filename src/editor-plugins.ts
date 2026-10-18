import { $prose } from "@milkdown/kit/utils";
import { gapCursor } from "@milkdown/kit/prose/gapcursor";
import type { Mark } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, type EditorState } from "@milkdown/kit/prose/state";
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

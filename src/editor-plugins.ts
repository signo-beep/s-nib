import { $prose } from "@milkdown/kit/utils";
import { gapCursor } from "@milkdown/kit/prose/gapcursor";
import type { Mark } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey, type EditorState } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";

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

/** Intervallo contiguo del testo, nel blocco corrente, che porta il mark dato. */
function markRange(state: EditorState, mark: Mark): { from: number; to: number } | null {
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
  return runs.find((run) => $from.pos >= run.from && $from.pos <= run.to) ?? null;
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
      decorations.push(markerWidget(`](${mark.attrs.href ?? ""})`, range.to, 1));
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
  return [Decoration.node($from.before(1), $from.after(1), { class: "focus-block" })];
}

function keepCaretCentered(view: { state: EditorState; coordsAtPos(pos: number): { top: number } }) {
  if (!document.body.classList.contains("typewriter")) return;
  const scroller = document.getElementById("scroller");
  if (!scroller) return;
  try {
    const caret = view.coordsAtPos(view.state.selection.head);
    const box = scroller.getBoundingClientRect();
    scroller.scrollTop += caret.top - (box.top + box.height * 0.4);
  } catch {
    // posizione non ancora renderizzata: ignorare
  }
}

/** Sintassi inline visibile sotto il cursore, blocco attivo per la modalità focus, modalità typewriter. */
export const editingExperience = $prose(
  () =>
    new Plugin({
      key: new PluginKey("s-nib-editing-experience"),
      props: {
        decorations(state) {
          return DecorationSet.create(state.doc, [
            ...revealDecorations(state),
            ...focusDecoration(state),
          ]);
        },
      },
      view: () => ({
        update(view, previous) {
          if (!view.hasFocus()) return;
          if (previous.selection.eq(view.state.selection) && previous.doc.eq(view.state.doc)) return;
          keepCaretCentered(view);
        },
      }),
    }),
);

/** Cursore tra blocchi adiacenti (immagine, diagramma, codice): permette di scrivere prima e dopo. */
export const gapCursorPlugin = $prose(() => gapCursor());

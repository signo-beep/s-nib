import { editorViewCtx, type Editor } from "@milkdown/kit/core";
import type { Node } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

/** Part of a match inside a single text node (a match can span several, with marks). */
interface Piece {
  from: number;
  to: number;
}

interface SearchState {
  query: string;
  caseSensitive: boolean;
  matches: Piece[][];
  current: number;
}

type SearchMeta = Partial<Pick<SearchState, "query" | "caseSensitive" | "current">>;

const key = new PluginKey<SearchState>("s-nib-search");
let onStateChange: (() => void) | null = null;

function findMatches(doc: Node, query: string, caseSensitive: boolean): Piece[][] {
  if (!query) return [];
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: Piece[][] = [];
  doc.descendants((node, pos) => {
    // code blocks are CodeMirror node views: decorations cannot reach them
    if (node.type.name === "code_block") return false;
    if (!node.isTextblock) return true;
    const segments: { pos: number; start: number; length: number }[] = [];
    let text = "";
    node.descendants((child, offset) => {
      if (!child.isText) return;
      segments.push({ pos: pos + 1 + offset, start: text.length, length: child.text!.length });
      text += child.text;
    });
    const haystack = caseSensitive ? text : text.toLowerCase();
    for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
      const end = i + needle.length;
      const pieces: Piece[] = [];
      for (const segment of segments) {
        const from = Math.max(i, segment.start);
        const to = Math.min(end, segment.start + segment.length);
        if (from < to) pieces.push({ from: segment.pos + from - segment.start, to: segment.pos + to - segment.start });
      }
      if (pieces.length) matches.push(pieces);
    }
    return false;
  });
  return matches;
}

export const searchPlugin = $prose(
  () =>
    new Plugin<SearchState>({
      key,
      state: {
        init: () => ({ query: "", caseSensitive: false, matches: [], current: 0 }),
        apply(tr, prev, _oldState, newState) {
          const meta = tr.getMeta(key) as SearchMeta | undefined;
          if (!meta && !tr.docChanged) return prev;
          const next = { ...prev, ...meta };
          if (meta && meta.current === undefined && (meta.query !== undefined || meta.caseSensitive !== undefined)) {
            next.current = 0;
          }
          next.matches = findMatches(newState.doc, next.query, next.caseSensitive);
          next.current = next.matches.length ? Math.min(Math.max(next.current, 0), next.matches.length - 1) : 0;
          return next;
        },
      },
      props: {
        decorations(state) {
          const search = key.getState(state);
          if (!search?.matches.length) return null;
          const decorations: Decoration[] = [];
          search.matches.forEach((pieces, index) => {
            const className = index === search.current ? "search-match search-current" : "search-match";
            for (const piece of pieces) decorations.push(Decoration.inline(piece.from, piece.to, { class: className }));
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
      view: () => ({ update: () => onStateChange?.() }),
    }),
);

/** Find bar (Ctrl+F) for the rendered document and for source mode. */
export function initSearch(editor: Editor, sourceEl: HTMLTextAreaElement, isSourceMode: () => boolean) {
  const bar = document.getElementById("search-bar")!;
  const input = document.getElementById("search-input") as HTMLInputElement;
  const countEl = document.getElementById("search-count")!;
  const caseButton = document.getElementById("search-case")!;
  let caseSensitive = false;
  let sourceMatches: number[] = [];
  let sourceCurrent = 0;

  const withView = <T,>(fn: (view: EditorView) => T): T => editor.action((ctx) => fn(ctx.get(editorViewCtx)));
  const dispatchMeta = (meta: SearchMeta) => withView((view) => view.dispatch(view.state.tr.setMeta(key, meta)));
  const getState = () => withView((view) => key.getState(view.state)!);

  function renderCount() {
    if (!input.value) {
      countEl.textContent = "";
      return;
    }
    if (isSourceMode()) {
      countEl.textContent = sourceMatches.length ? `${sourceCurrent + 1}/${sourceMatches.length}` : "No results";
    } else {
      const { matches, current } = getState();
      countEl.textContent = matches.length ? `${current + 1}/${matches.length}` : "No results";
    }
  }

  function computeSourceMatches() {
    sourceMatches = [];
    const query = caseSensitive ? input.value : input.value.toLowerCase();
    if (!query) return;
    const text = caseSensitive ? sourceEl.value : sourceEl.value.toLowerCase();
    for (let i = text.indexOf(query); i !== -1; i = text.indexOf(query, i + query.length)) sourceMatches.push(i);
  }

  function reveal() {
    if (isSourceMode()) {
      const start = sourceMatches[sourceCurrent];
      if (start === undefined) return;
      sourceEl.setSelectionRange(start, start + input.value.length);
      // blur and focus make the textarea scroll to the selection
      sourceEl.blur();
      sourceEl.focus();
      input.focus();
    } else {
      requestAnimationFrame(() => document.querySelector(".search-current")?.scrollIntoView({ block: "center" }));
    }
  }

  function update(jump: boolean) {
    dispatchMeta({ query: input.value, caseSensitive });
    computeSourceMatches();
    sourceCurrent = 0;
    renderCount();
    if (jump) reveal();
  }

  function step(delta: number) {
    if (!input.value) return;
    if (isSourceMode()) {
      if (!sourceMatches.length) return;
      sourceCurrent = (sourceCurrent + delta + sourceMatches.length) % sourceMatches.length;
    } else {
      const { matches, current } = getState();
      if (!matches.length) return;
      dispatchMeta({ current: (current + delta + matches.length) % matches.length });
    }
    renderCount();
    reveal();
  }

  function open() {
    const selected = isSourceMode()
      ? sourceEl.value.slice(sourceEl.selectionStart, sourceEl.selectionEnd)
      : withView((view) => view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, " "));
    if (selected && selected.length <= 100 && !selected.includes("\n")) input.value = selected;
    bar.hidden = false;
    input.focus();
    input.select();
    update(true);
  }

  function close() {
    if (bar.hidden) return;
    bar.hidden = true;
    dispatchMeta({ query: "" });
    if (isSourceMode()) sourceEl.focus();
    else withView((view) => view.focus());
  }

  onStateChange = () => {
    if (!bar.hidden) renderCount();
  };

  document.addEventListener(
    "keydown",
    (event) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        open();
      }
    },
    true,
  );
  input.addEventListener("input", () => update(true));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  document.getElementById("search-prev")!.addEventListener("click", () => step(-1));
  document.getElementById("search-next")!.addEventListener("click", () => step(1));
  document.getElementById("search-close")!.addEventListener("click", close);
  caseButton.addEventListener("click", () => {
    caseSensitive = !caseSensitive;
    caseButton.classList.toggle("active", caseSensitive);
    caseButton.setAttribute("aria-pressed", String(caseSensitive));
    update(true);
  });
  sourceEl.addEventListener("input", () => {
    if (bar.hidden || !input.value) return;
    computeSourceMatches();
    sourceCurrent = Math.min(sourceCurrent, Math.max(sourceMatches.length - 1, 0));
    renderCount();
  });

  /** Call after switching between rendered and source mode. */
  return () => {
    if (bar.hidden) return;
    update(false);
  };
}

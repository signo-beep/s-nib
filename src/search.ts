import { editorViewCtx, type Editor } from "@milkdown/kit/core";
import type { Node } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import { showToast } from "./toast";

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

/** Pane the find bar works on: the active one. */
export interface SearchTarget {
  editor: Editor;
  sourceEl: HTMLTextAreaElement;
  root: HTMLElement;
  sourceMode: boolean;
}

/** Find bar (Ctrl+F) for the rendered document and for source mode of the active pane. */
export function initSearch(getTarget: () => SearchTarget) {
  const isSourceMode = () => getTarget().sourceMode;
  const bar = document.getElementById("search-bar")!;
  const input = document.getElementById("search-input") as HTMLInputElement;
  const countEl = document.getElementById("search-count")!;
  const caseButton = document.getElementById("search-case")!;
  const replaceRow = document.getElementById("replace-row")!;
  const replaceInput = document.getElementById("replace-input") as HTMLInputElement;
  let caseSensitive = false;
  let sourceMatches: number[] = [];
  let sourceCurrent = 0;

  const withView = <T,>(fn: (view: EditorView) => T, editor = getTarget().editor): T => editor.action((ctx) => fn(ctx.get(editorViewCtx)));
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
    const { sourceEl } = getTarget();
    const text = caseSensitive ? sourceEl.value : sourceEl.value.toLowerCase();
    for (let i = text.indexOf(query); i !== -1; i = text.indexOf(query, i + query.length)) sourceMatches.push(i);
  }

  function reveal() {
    if (isSourceMode()) {
      const { sourceEl } = getTarget();
      const start = sourceMatches[sourceCurrent];
      if (start === undefined) return;
      sourceEl.setSelectionRange(start, start + input.value.length);
      // blur and focus make the textarea scroll to the selection
      sourceEl.blur();
      sourceEl.focus();
      input.focus();
    } else {
      requestAnimationFrame(() => getTarget().root.querySelector(".search-current")?.scrollIntoView({ block: "center" }));
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

  /** Replaces one match (all its pieces, a match can span several marks) in a single transaction. */
  function replaceCurrent() {
    if (!input.value) return;
    const replacement = replaceInput.value;
    if (isSourceMode()) {
      const start = sourceMatches[sourceCurrent];
      if (start === undefined) return;
      writeSource(start, start + input.value.length, replacement);
      computeSourceMatches();
      const index = sourceMatches.findIndex((position) => position >= start + replacement.length);
      sourceCurrent = index === -1 ? 0 : index;
    } else {
      const { matches, current } = getState();
      const pieces = matches[current];
      if (!pieces) return;
      const end = pieces[0].from + replacement.length;
      withView((view) => {
        const tr = view.state.tr;
        for (let i = pieces.length - 1; i >= 0; i--) {
          if (i === 0 && replacement) tr.insertText(replacement, pieces[i].from, pieces[i].to);
          else tr.delete(pieces[i].from, pieces[i].to);
        }
        view.dispatch(tr);
      });
      const next = getState().matches.findIndex((item) => item[0].from >= end);
      dispatchMeta({ current: next === -1 ? 0 : next });
    }
    renderCount();
    reveal();
  }

  function replaceEvery() {
    if (!input.value) return;
    const replacement = replaceInput.value;
    let count = 0;
    if (isSourceMode()) {
      const { sourceEl } = getTarget();
      const length = input.value.length;
      count = sourceMatches.length;
      if (!count) return;
      let result = "";
      let last = 0;
      for (const start of sourceMatches) {
        result += sourceEl.value.slice(last, start) + replacement;
        last = start + length;
      }
      result += sourceEl.value.slice(last);
      const scroll = sourceEl.scrollTop;
      writeSource(0, sourceEl.value.length, result);
      sourceEl.scrollTop = scroll;
      computeSourceMatches();
      sourceCurrent = 0;
    } else {
      const { matches } = getState();
      count = matches.length;
      if (!count) return;
      withView((view) => {
        const tr = view.state.tr;
        // from the end, so that the positions of the earlier matches stay valid
        for (let m = matches.length - 1; m >= 0; m--) {
          const pieces = matches[m];
          for (let i = pieces.length - 1; i >= 0; i--) {
            if (i === 0 && replacement) tr.insertText(replacement, pieces[i].from, pieces[i].to);
            else tr.delete(pieces[i].from, pieces[i].to);
          }
        }
        view.dispatch(tr);
      });
    }
    renderCount();
    showToast(`Replaced ${count} ${count === 1 ? "match" : "matches"}`);
  }

  /** Edits the source text keeping the native undo history of the textarea. */
  function writeSource(from: number, to: number, text: string) {
    const { sourceEl } = getTarget();
    sourceEl.focus();
    sourceEl.setSelectionRange(from, to);
    const done = text ? document.execCommand("insertText", false, text) : document.execCommand("delete");
    if (!done) {
      sourceEl.setRangeText(text, from, to, "end");
      sourceEl.dispatchEvent(new Event("input", { bubbles: true }));
    }
    replaceInput.focus();
  }

  function open(replace = false) {
    const { sourceEl } = getTarget();
    const selected = isSourceMode()
      ? sourceEl.value.slice(sourceEl.selectionStart, sourceEl.selectionEnd)
      : withView((view) => view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, " "));
    if (selected && selected.length <= 100 && !selected.includes("\n")) input.value = selected;
    bar.hidden = false;
    if (replace) replaceRow.hidden = false;
    input.focus();
    input.select();
    update(true);
  }

  /** Opens the bar with a given text (from the folder search). */
  function openWith(query: string) {
    input.value = query;
    bar.hidden = false;
    update(true);
  }

  function close() {
    if (bar.hidden) return;
    bar.hidden = true;
    replaceRow.hidden = true;
    dispatchMeta({ query: "" });
    if (isSourceMode()) getTarget().sourceEl.focus();
    else withView((view) => view.focus());
  }

  onStateChange = () => {
    if (!bar.hidden) renderCount();
  };

  document.addEventListener(
    "keydown",
    (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "f" || key === "h") {
        event.preventDefault();
        open(key === "h");
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
  replaceInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) replaceEvery();
      else replaceCurrent();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  document.getElementById("replace-one")!.addEventListener("click", replaceCurrent);
  document.getElementById("replace-all")!.addEventListener("click", replaceEvery);
  document.getElementById("search-prev")!.addEventListener("click", () => step(-1));
  document.getElementById("search-next")!.addEventListener("click", () => step(1));
  document.getElementById("search-close")!.addEventListener("click", close);
  caseButton.addEventListener("click", () => {
    caseSensitive = !caseSensitive;
    caseButton.classList.toggle("active", caseSensitive);
    caseButton.setAttribute("aria-pressed", String(caseSensitive));
    update(true);
  });

  return {
    openWith,
    /** Call after the source text of the active pane changes. */
    onSourceInput() {
      if (bar.hidden || !input.value) return;
      computeSourceMatches();
      sourceCurrent = Math.min(sourceCurrent, Math.max(sourceMatches.length - 1, 0));
      renderCount();
    },
    /** Call after switching between rendered and source mode. */
    refresh() {
      if (bar.hidden) return;
      update(false);
    },
    /** Call when another pane becomes active: clears the highlights of the old one. */
    retarget(previous: Editor) {
      if (bar.hidden) return;
      withView((view) => view.dispatch(view.state.tr.setMeta(key, { query: "" })), previous);
      update(false);
    },
  };
}

import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import { $inputRule, $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import { InputRule } from "@milkdown/kit/prose/inputrules";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { NodeSelection, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import katex from "katex";
import "katex/dist/katex.min.css";
import remarkMath from "remark-math";

function renderTex(target: HTMLElement, tex: string, displayMode: boolean) {
  target.replaceChildren();
  if (!tex.trim()) {
    const hint = document.createElement("span");
    hint.className = "math-empty";
    hint.textContent = displayMode ? "Formula (LaTeX)" : "formula";
    target.append(hint);
    return;
  }
  katex.render(tex, target, { displayMode, throwOnError: false, strict: "ignore", trust: false, output: "html" });
}

const remarkMathPlugin = $remark("remarkMath", () => remarkMath);

const mathInlineSchema = $nodeSchema("math_inline", () => ({
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  marks: "",
  attrs: { value: { default: "" } },
  parseDOM: [
    { tag: 'span[data-type="math_inline"]', getAttrs: (dom) => ({ value: (dom as HTMLElement).dataset.value ?? "" }) },
  ],
  toDOM: (node) => ["span", { "data-type": "math_inline", "data-value": node.attrs.value }, node.attrs.value],
  parseMarkdown: {
    match: (node) => node.type === "inlineMath",
    runner: (state, node, type) => {
      state.addNode(type, { value: String(node.value ?? "") });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "math_inline",
    runner: (state, node) => {
      state.addNode("inlineMath", undefined, node.attrs.value);
    },
  },
}));

const mathBlockSchema = $nodeSchema("math_block", () => ({
  group: "block",
  atom: true,
  selectable: true,
  defining: true,
  isolating: true,
  marks: "",
  attrs: { value: { default: "" } },
  parseDOM: [
    { tag: 'div[data-type="math_block"]', getAttrs: (dom) => ({ value: (dom as HTMLElement).dataset.value ?? "" }) },
  ],
  toDOM: (node) => ["div", { "data-type": "math_block", "data-value": node.attrs.value }, node.attrs.value],
  parseMarkdown: {
    match: (node) => node.type === "math",
    runner: (state, node, type) => {
      state.addNode(type, { value: String(node.value ?? "") });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "math_block",
    runner: (state, node) => {
      state.addNode("math", undefined, node.attrs.value);
    },
  },
}));

/**
 * Vista di un nodo formula: mostra il rendering KaTeX, un clic apre il campo LaTeX.
 * Blocco: textarea (Ctrl+Invio o Esc per chiudere). Inline: input (Invio o Esc).
 */
function mathNodeView(block: boolean) {
  return () => (initial: ProseNode, view: EditorView, getPos: () => number | undefined) => {
    let node = initial;
    let editing = false;
    const dom = document.createElement(block ? "div" : "span");
    dom.className = block ? "math-node math-block" : "math-node math-inline";
    const preview = document.createElement(block ? "div" : "span");
    preview.className = "math-render";
    const field = block ? document.createElement("textarea") : document.createElement("input");
    field.className = "math-source";
    field.spellcheck = false;
    field.hidden = true;
    dom.append(preview, field);

    const draw = () => renderTex(preview, node.attrs.value, block);
    const size = () => {
      if (block) {
        field.style.height = "auto";
        field.style.height = `${Math.max(field.scrollHeight, 48)}px`;
      } else {
        field.style.width = `${Math.max(field.value.length + 2, 6)}ch`;
      }
    };

    const commit = () => {
      const pos = getPos();
      if (pos == null || field.value === node.attrs.value) return;
      view.dispatch(view.state.tr.setNodeAttribute(pos, "value", field.value));
    };

    const leave = () => {
      if (!editing) return;
      editing = false;
      commit();
      field.hidden = true;
      preview.hidden = false;
      dom.classList.remove("editing");
      draw();
    };

    const afterNode = () => {
      const pos = getPos();
      if (pos == null) return;
      leave();
      const end = pos + node.nodeSize;
      const selection = TextSelection.near(view.state.doc.resolve(Math.min(end, view.state.doc.content.size)), 1);
      view.dispatch(view.state.tr.setSelection(selection));
      view.focus();
    };

    const enter = () => {
      if (editing || !view.editable) return;
      editing = true;
      field.value = node.attrs.value;
      preview.hidden = true;
      field.hidden = false;
      dom.classList.add("editing");
      size();
      field.focus();
    };

    field.addEventListener("input", () => {
      size();
      node = node.type.create({ ...node.attrs, value: field.value });
      renderTex(preview, field.value, block);
    });
    field.addEventListener("blur", leave);
    field.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      const ctrl = (event as KeyboardEvent).ctrlKey || (event as KeyboardEvent).metaKey;
      if (key === "Escape" || (key === "Enter" && (!block || ctrl))) {
        event.preventDefault();
        event.stopPropagation();
        afterNode();
      }
    });
    dom.addEventListener("click", enter);

    draw();
    if (!node.attrs.value && view.editable) queueMicrotask(enter);

    return {
      dom,
      update(next: ProseNode) {
        if (next.type !== node.type) return false;
        node = next;
        if (!editing) draw();
        return true;
      },
      selectNode() {
        dom.classList.add("selected");
      },
      deselectNode() {
        dom.classList.remove("selected");
      },
      stopEvent(event: Event) {
        return editing && event.target === field;
      },
      ignoreMutation() {
        return true;
      },
      destroy() {
        editing = false;
      },
    };
  };
}

const mathInlineView = $view(mathInlineSchema.node, mathNodeView(false));
const mathBlockView = $view(mathBlockSchema.node, mathNodeView(true));

/** Digitare $x^2$ crea una formula inline. */
const mathInlineRule = $inputRule(
  (ctx) =>
    new InputRule(/(?:^|[^$\\])\$([^$\s][^$]*)\$$/, (state, match, start, end) => {
      const type = mathInlineSchema.type(ctx);
      const tex = match[1];
      const from = start + match[0].indexOf("$");
      const tr = state.tr.replaceWith(from, end, type.create({ value: tex }));
      return tr.setSelection(NodeSelection.create(tr.doc, from));
    }),
);

/** Digitare $$ e uno spazio a inizio riga crea una formula a blocco. */
const mathBlockRule = $inputRule(
  (ctx) =>
    new InputRule(/^\$\$\s$/, (state, _match, start, end) => {
      const type = mathBlockSchema.type(ctx);
      const $start = state.doc.resolve(start);
      const index = $start.index(-1);
      if (!$start.node(-1).canReplaceWith(index, $start.indexAfter(-1), type)) return null;
      return state.tr.delete(start, end).setBlockType(start, start, type);
    }),
);

export const mathPlugin: MilkdownPlugin[] = [
  remarkMathPlugin,
  mathInlineSchema,
  mathBlockSchema,
  mathInlineView,
  mathBlockView,
  mathInlineRule,
  mathBlockRule,
].flat();

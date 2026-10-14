import { blockquoteSchema } from "@milkdown/kit/preset/commonmark";
import { wrapIn } from "@milkdown/kit/prose/commands";
import type { EditorView } from "@milkdown/kit/prose/view";

export const ALERT_TYPES = ["note", "tip", "important", "warning", "caution"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\r?\n?/i;

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

/** Splits a leading `[!TYPE]` marker off the blockquote content (GFM alert). */
function readAlert(children: MdNode[]): { alert: AlertType | null; children: MdNode[] } {
  const [first, ...rest] = children;
  const text = first?.type === "paragraph" ? first.children?.[0] : undefined;
  const match = text?.type === "text" && text.value ? MARKER.exec(text.value) : null;
  if (!first || !text || !match) return { alert: null, children };

  const remaining = text.value!.slice(match[0].length);
  let tail = (first.children ?? []).slice(1);
  // the Markdown pipeline turns the newline after the marker into a break node
  if (!remaining && tail[0]?.type === "break") tail = tail.slice(1);
  const inline = [...(remaining ? [{ ...text, value: remaining }] : []), ...tail];
  const body = inline.length ? [{ ...first, children: inline }, ...rest] : rest;
  return {
    alert: match[1].toLowerCase() as AlertType,
    children: body.length ? body : [{ type: "paragraph", children: [] }],
  };
}

/** Blockquote with an optional GFM alert type: `> [!NOTE]`. The Markdown stays standard. */
export const alertBlockquote = blockquoteSchema.extendSchema((previous) => (ctx) => {
  const base = previous(ctx);
  return {
    ...base,
    attrs: { alert: { default: null } },
    parseDOM: [
      {
        tag: "blockquote",
        getAttrs: (dom) => ({ alert: (dom as HTMLElement).dataset.alert ?? null }),
      },
    ],
    toDOM: (node) => {
      const [tag, attrs] = base.toDOM!(node) as [string, Record<string, string>, 0];
      const alert = node.attrs.alert as AlertType | null;
      return [tag, alert ? { ...attrs, "data-alert": alert } : attrs, 0];
    },
    parseMarkdown: {
      match: ({ type }) => type === "blockquote",
      runner: (state, node, type) => {
        const { alert, children } = readAlert((node.children ?? []) as MdNode[]);
        state.openNode(type, { alert }).next(children as never).closeNode();
      },
    },
    toMarkdown: {
      match: (node) => node.type.name === "blockquote",
      runner: (state, node) => {
        state.openNode("blockquote");
        if (node.attrs.alert) state.addNode("html", undefined, `[!${String(node.attrs.alert).toUpperCase()}]`);
        const empty = node.childCount === 1 && node.firstChild!.isTextblock && node.firstChild!.childCount === 0;
        if (!(node.attrs.alert && empty)) state.next(node.content);
        state.closeNode();
      },
    },
  };
});

/** Sets or removes the alert type of the blockquote around the cursor (wraps the block if needed). */
export function setAlert(view: EditorView, alert: AlertType | null): boolean {
  const { state } = view;
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name !== "blockquote") continue;
    view.dispatch(state.tr.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, alert }));
    view.focus();
    return true;
  }
  if (!alert) return false;
  const done = wrapIn(state.schema.nodes.blockquote, { alert })(state, view.dispatch);
  view.focus();
  return done;
}

/** Alert type of the blockquote around the cursor, null when outside or a plain quote. */
export function currentAlert(view: EditorView): AlertType | null {
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "blockquote") return (node.attrs.alert as AlertType | null) ?? null;
  }
  return null;
}

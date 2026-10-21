import { language } from "@codemirror/language";
import { type EditorState, type Extension, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { requestSections } from "./http-request";

class SendButton extends WidgetType {
  constructor(
    private readonly line: number,
    private readonly shownAt: number,
    private readonly onSend: () => void,
  ) {
    super();
  }

  eq(other: SendButton): boolean {
    return other.line === this.line && other.shownAt === this.shownAt;
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "http-send";
    button.textContent = "Send request";
    // keep the editor focus: the click first moves the cursor into this request
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const at = view.state.doc.line(this.line + 1).from;
      view.dispatch({ selection: { anchor: at } });
      // the selection reaches ProseMirror through the code block view: send once it has
      setTimeout(this.onSend, 0);
    });
    return button;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** A "Send request" button above every request of an `http` code block (like CodeLens in VS Code). */
export function httpLens(onSend: () => void): Extension {
  return StateField.define({
    create: (state) => buttons(state, onSend),
    update: (value, transaction) =>
      transaction.docChanged || transaction.startState.facet(language) !== transaction.state.facet(language)
        ? buttons(transaction.state, onSend)
        : value,
    provide: (field) => EditorView.decorations.from(field),
  });
}

function buttons(state: EditorState, onSend: () => void) {
  if (state.facet(language)?.name !== "http") return Decoration.none;
  const text = state.doc.toString();
  return Decoration.set(
    requestSections(text).map(({ start, request }) =>
      Decoration.widget({
        widget: new SendButton(request, start, onSend),
        block: true,
        side: -1,
      }).range(state.doc.line(start + 1).from),
    ),
  );
}

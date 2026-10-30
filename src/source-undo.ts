/** Undo and redo for the source textarea, kept by hand: the native history does nothing in the WebView. */

const STEP_DELAY_MS = 250;
const MAX_STEPS = 200;

interface Snapshot {
  value: string;
  start: number;
  end: number;
}

export interface SourceUndo {
  /** Forget the history and take the current text as the starting point (after the text is replaced by code). */
  reset(): void;
}

export function attachSourceUndo(area: HTMLTextAreaElement): SourceUndo {
  let steps: Snapshot[] = [];
  let index = 0;
  let lastInput = 0;
  let applying = false;

  const snapshot = (): Snapshot => ({
    value: area.value,
    start: area.selectionStart,
    end: area.selectionEnd,
  });

  const reset = () => {
    steps = [snapshot()];
    index = 0;
    lastInput = 0;
  };

  const apply = (target: number) => {
    const step = steps[target];
    if (!step) return;
    index = target;
    lastInput = 0;
    applying = true;
    area.value = step.value;
    area.setSelectionRange(step.start, step.end);
    // let the dirty flag, search and autosave follow the new text
    area.dispatchEvent(new Event("input", { bubbles: true }));
    applying = false;
  };

  area.addEventListener("input", () => {
    if (applying) return;
    const now = Date.now();
    steps.length = index + 1; // an edit drops the redo steps
    // typing without a pause stays in one step
    if (now - lastInput < STEP_DELAY_MS && index > 0) steps[index] = snapshot();
    else {
      steps.push(snapshot());
      if (steps.length > MAX_STEPS) steps.shift();
      index = steps.length - 1;
    }
    lastInput = now;
  });

  area.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const redo = event.code === "KeyY" || (event.code === "KeyZ" && event.shiftKey);
    if (!redo && event.code !== "KeyZ") return;
    event.preventDefault();
    apply(redo ? Math.min(index + 1, steps.length - 1) : Math.max(index - 1, 0));
  });

  reset();
  return { reset };
}

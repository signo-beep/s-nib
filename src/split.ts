const STEP = 2;
const MIN = 20;
const MAX = 80;

/** Draggable divider between the two panes: sets `--split` (percent for the left pane) on the container. */
export function initSplitResizer(container: HTMLElement, handle: HTMLElement) {
  const clamp = (value: number) => Math.min(MAX, Math.max(MIN, value));
  const set = (value: number, persist: boolean) => {
    const percent = clamp(value);
    container.style.setProperty("--split", String(percent));
    if (!persist) return;
    try {
      localStorage.setItem("splitPercent", String(percent));
    } catch {
      // storage unavailable: the position only applies to this session
    }
  };
  const current = () => Number(container.style.getPropertyValue("--split")) || 50;
  try {
    const saved = Number(localStorage.getItem("splitPercent"));
    if (saved) set(saved, false);
  } catch {
    // storage unavailable: default position
  }

  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "Resize panes");
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing");
  });
  handle.addEventListener("pointermove", (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    const box = container.getBoundingClientRect();
    set(((event.clientX - box.left) / box.width) * 100, false);
  });
  const end = (event: PointerEvent) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    handle.releasePointerCapture(event.pointerId);
    document.body.classList.remove("resizing");
    set(current(), true);
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("dblclick", () => set(50, true));
  handle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    set(current() + (event.key === "ArrowRight" ? STEP : -STEP), true);
  });
}

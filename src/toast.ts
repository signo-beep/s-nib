let timer: number | undefined;

/** Short message at the bottom right; errors stay longer. */
export function showToast(text: string, kind: "info" | "error" = "info", ms = 3500) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = text;
  toast.dataset.kind = kind;
  toast.hidden = false;
  window.clearTimeout(timer);
  if (ms > 0) {
    timer = window.setTimeout(() => {
      toast.hidden = true;
    }, kind === "error" ? Math.max(ms, 8000) : ms);
  }
}

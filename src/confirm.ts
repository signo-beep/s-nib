/** Themed confirmation dialog (the native one repeats its title twice on GTK). Resolves true on OK. */
export function confirmDialog(message: string, okLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    const box = document.createElement("div");
    box.className = "confirm-box";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    const text = document.createElement("p");
    text.textContent = message;
    const buttons = document.createElement("div");
    buttons.className = "confirm-buttons";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "danger";
    ok.textContent = okLabel;
    buttons.append(cancel, ok);
    box.append(text, buttons);
    overlay.append(box);

    const previous = document.activeElement as HTMLElement | null;
    const finish = (value: boolean) => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      previous?.focus?.();
      resolve(value);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      } else if (event.key === "Tab") {
        event.preventDefault();
        (document.activeElement === ok ? cancel : ok).focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    ok.addEventListener("click", () => finish(true));
    cancel.addEventListener("click", () => finish(false));
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) finish(false);
    });
    document.body.append(overlay);
    // focus Cancel: Enter must not delete by accident
    cancel.focus();
  });
}

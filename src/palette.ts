export interface PaletteCommand {
  action: string;
  label: string;
  keys?: string;
}

/** Command palette (Ctrl+Shift+P): type to filter, arrows to move, Enter to run. */
export function initPalette(commands: PaletteCommand[], run: (action: string) => void) {
  const dialog = document.createElement("dialog");
  dialog.id = "palette";
  dialog.className = "app-dialog";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Type a command";
  input.setAttribute("aria-label", "Command");
  const list = document.createElement("ul");
  list.setAttribute("role", "listbox");
  dialog.append(input, list);
  document.body.append(dialog);

  let shown: PaletteCommand[] = [];
  let selected = 0;

  function render() {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = commands.filter((command) => words.every((word) => command.label.toLowerCase().includes(word)));
    selected = Math.min(selected, Math.max(0, shown.length - 1));
    list.replaceChildren(
      ...shown.map((command, index) => {
        const item = document.createElement("li");
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(index === selected));
        item.dataset.index = String(index);
        const label = document.createElement("span");
        label.textContent = command.label;
        item.append(label);
        if (command.keys) {
          const keys = document.createElement("kbd");
          keys.textContent = command.keys;
          item.append(keys);
        }
        return item;
      }),
    );
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }

  function choose(index: number) {
    const command = shown[index];
    if (!command) return;
    dialog.close();
    run(command.action);
  }

  input.addEventListener("input", () => {
    selected = 0;
    render();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      selected = shown.length ? (selected + step + shown.length) % shown.length : 0;
      render();
    } else if (event.key === "Enter") {
      choose(selected);
    } else {
      return;
    }
    event.preventDefault();
  });
  list.addEventListener("click", (event) => {
    const item = (event.target as Element).closest<HTMLElement>("[data-index]");
    if (item) choose(Number(item.dataset.index));
  });
  dialog.addEventListener("mousedown", (event) => {
    if (event.target === dialog) dialog.close();
  });

  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.key.toLowerCase() !== "p") return;
    event.preventDefault();
    if (dialog.open) return;
    input.value = "";
    selected = 0;
    render();
    dialog.showModal();
    input.focus();
  });
}

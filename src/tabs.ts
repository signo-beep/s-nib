export interface TabView {
  title: string;
  dirty: boolean;
}

interface TabsOptions {
  onSelect: (index: number) => void;
  onClose: (index: number) => void;
  onNew: () => void;
}

const barEl = document.getElementById("tab-bar")!;
const listEl = document.getElementById("tab-list")!;

/** Tab bar above the document: returns the function that redraws it. */
export function initTabs(options: TabsOptions) {
  listEl.addEventListener("click", (event) => {
    const target = event.target as Element;
    const tab = target.closest<HTMLElement>("[data-index]");
    if (!tab) return;
    const index = Number(tab.dataset.index);
    if (target.closest(".tab-close")) options.onClose(index);
    else options.onSelect(index);
  });
  // middle click closes the tab
  listEl.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    const tab = (event.target as Element).closest<HTMLElement>("[data-index]");
    if (tab) options.onClose(Number(tab.dataset.index));
  });
  document.getElementById("tab-new")!.addEventListener("click", options.onNew);

  return function render(tabs: TabView[], active: number) {
    barEl.hidden = false;
    const nodes = tabs.map((tab, index) => {
      const el = document.createElement("div");
      el.className = "doc-tab" + (index === active ? " active" : "");
      el.dataset.index = String(index);
      el.title = tab.title;
      el.setAttribute("role", "tab");
      el.setAttribute("aria-selected", String(index === active));
      const label = document.createElement("span");
      label.className = "tab-title";
      label.textContent = (tab.dirty ? "● " : "") + tab.title;
      const close = document.createElement("button");
      close.type = "button";
      close.className = "tab-close";
      close.title = "Close tab (Ctrl+W)";
      close.setAttribute("aria-label", `Close ${tab.title}`);
      close.textContent = "✕";
      el.append(label, close);
      return el;
    });
    listEl.replaceChildren(...nodes);
    listEl.children[active]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
}

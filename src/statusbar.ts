const bar = document.getElementById("statusbar")!;

function countWords(text: string): number {
  return text.match(/\S+/g)?.length ?? 0;
}

/** Word and character counts of the active document; the selection, if any, comes first. */
export function setStatus(text: string, selection: string) {
  const words = countWords(text);
  const parts = [`${words} ${words === 1 ? "word" : "words"}`, `${text.length} characters`];
  const selected = countWords(selection);
  if (selected) parts.unshift(`${selected} selected (${selection.length} characters)`);
  bar.textContent = parts.filter(Boolean).join("  ·  ");
}

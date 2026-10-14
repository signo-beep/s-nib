import { invoke } from "@tauri-apps/api/core";

interface MathItem {
  display: boolean;
  tex: string;
}

/**
 * Document formulas rendered to SVG with MathJax, keyed by "d:" (block) or "i:" (inline)
 * followed by the LaTeX. The list comes from the Rust Markdown parser, so it matches the export.
 */
export async function collectFormulas(markdown: string): Promise<Record<string, string>> {
  const items = await invoke<MathItem[]>("list_math", { markdown });
  if (items.length === 0) return {};
  const { texToSvg } = await import("./mathjax-render");
  const formulas: Record<string, string> = {};
  for (const { display, tex } of items) {
    try {
      const svg = texToSvg(tex, display);
      if (svg) formulas[`${display ? "d" : "i"}:${tex}`] = svg;
    } catch {
      // invalid LaTeX: the formula text stays as is in the export
    }
  }
  return formulas;
}

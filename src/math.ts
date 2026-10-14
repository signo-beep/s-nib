import { invoke } from "@tauri-apps/api/core";

interface MathItem {
  display: boolean;
  tex: string;
}

/**
 * Formule del documento rese in SVG con MathJax, indicizzate da "d:" (blocco) o "i:" (inline)
 * seguito dal LaTeX. L'elenco viene dal parser Markdown di Rust, così coincide con quello dell'export.
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
      // LaTeX non valido: nell'export resta il testo della formula
    }
  }
  return formulas;
}

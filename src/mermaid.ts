type MermaidApi = typeof import("mermaid").default;

let apiPromise: Promise<MermaidApi> | null = null;
let counter = 0;

/** Carica Mermaid solo al primo uso (la libreria è pesante). */
function loadMermaid(): Promise<MermaidApi> {
  apiPromise ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "default",
      // etichette SVG native: le etichette HTML (foreignObject) non si possono esportare in PDF
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      suppressErrorRendering: true,
      fontFamily: '"Open Sans", sans-serif',
    });
    return mermaid;
  });
  return apiPromise;
}

export function isMermaidLanguage(language: string): boolean {
  return language.trim().toLowerCase() === "mermaid";
}

/** Rende il codice Mermaid in una stringa SVG; lancia se la sintassi non è valida. */
export async function renderMermaid(code: string): Promise<string> {
  const mermaid = await loadMermaid();
  const { svg } = await mermaid.render(`snib-mermaid-${++counter}`, code);
  return svg;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid[^\n]*\n([\s\S]*?)\n {0,3}\1[`~]*[ \t]*$/gim;

/** Diagrammi del documento già resi in SVG, indicizzati dal codice sorgente (senza spazi ai bordi). */
export async function collectDiagrams(markdown: string): Promise<Record<string, string>> {
  const diagrams: Record<string, string> = {};
  const codes = new Set<string>();
  for (const match of markdown.matchAll(FENCE)) {
    const code = match[2].trim();
    if (code) codes.add(code);
  }
  for (const code of codes) {
    try {
      diagrams[code] = await renderMermaid(code);
    } catch {
      // sintassi non valida: nell'export resta il blocco di codice
    }
  }
  return diagrams;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

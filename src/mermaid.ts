type MermaidApi = typeof import("mermaid").default;

let apiPromise: Promise<MermaidApi> | null = null;
let counter = 0;

/** Loads Mermaid on first use only (the library is heavy). */
function loadMermaid(): Promise<MermaidApi> {
  apiPromise ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "default",
      // native SVG labels: HTML labels (foreignObject) cannot be exported to PDF
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

/** Renders Mermaid code to an SVG string; throws if the syntax is invalid. */
export async function renderMermaid(code: string): Promise<string> {
  const mermaid = await loadMermaid();
  const { svg } = await mermaid.render(`snib-mermaid-${++counter}`, code);
  return svg;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid[^\n]*\n([\s\S]*?)\n {0,3}\1[`~]*[ \t]*$/gim;

/** Document diagrams already rendered to SVG, keyed by source code (trimmed). */
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
      // invalid syntax: the code block stays as is in the export
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

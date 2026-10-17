import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import exportStyles from "./export.css?inline";
import { collectHighlights } from "./highlight";
import { collectFormulas } from "./math";
import { collectDiagrams } from "./mermaid";

const THEME_VARIABLES = [
  "--bg",
  "--fg",
  "--muted",
  "--border",
  "--accent",
  "--code-bg",
  "--stripe-bg",
  "--hl-keyword",
  "--hl-string",
  "--hl-comment",
  "--hl-number",
  "--hl-fn",
  "--hl-type",
  "--hl-prop",
  "--hl-op",
  "--font-body",
  "--font-mono",
];

/** Variables of the active theme, read from the document, plus the exported document CSS. */
function buildExportCss(): string {
  const style = getComputedStyle(document.documentElement);
  const variables = THEME_VARIABLES.map(
    (name) => `${name}: ${style.getPropertyValue(name).trim()};`,
  );
  return `:root { ${variables.join(" ")} }\n${exportStyles}`;
}

function parentDir(path: string): string | null {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : null;
}

function stem(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.[^.]*$/, "");
}

export async function exportHtml(
  markdown: string,
  currentPath: string | null,
): Promise<void> {
  const title = currentPath ? stem(currentPath) : "Untitled";
  const defaultPath = currentPath
    ? currentPath.replace(/\.[^.\\/]*$/, "") + ".html"
    : "untitled.html";
  const target = await save({
    filters: [{ name: "HTML", extensions: ["html"] }],
    defaultPath,
  });
  if (!target) return;
  const html = await invoke<string>("render_html", {
    markdown,
    baseDir: currentPath ? parentDir(currentPath) : null,
    title,
    css: buildExportCss(),
    diagrams: await collectDiagrams(markdown),
    formulas: await collectFormulas(markdown),
    highlights: await collectHighlights(markdown),
  });
  await invoke("write_text_file", { path: target, content: html });
}

export function printDocument(): Promise<void> {
  return invoke("print_page");
}

/** Word or OpenDocument export through pandoc (installed separately; the backend explains how if missing). */
export async function exportPandoc(
  markdown: string,
  currentPath: string | null,
  format: "docx" | "odt",
): Promise<void> {
  const base = currentPath
    ? currentPath.replace(/\.[^.\\/]*$/, "")
    : "untitled";
  const target = await save({
    filters: [
      {
        name: format === "docx" ? "Word" : "OpenDocument",
        extensions: [format],
      },
    ],
    defaultPath: `${base}.${format}`,
  });
  if (!target) return;
  await invoke("export_pandoc", {
    path: target,
    markdown,
    format,
    baseDir: currentPath ? parentDir(currentPath) : null,
  });
}

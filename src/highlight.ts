import { invoke } from "@tauri-apps/api/core";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode, tagHighlighter, tags as t } from "@lezer/highlight";
import { escapeHtml } from "./mermaid";

interface CodeItem {
  lang: string;
  code: string;
}

// Same groups as the editor: the colors come from the --hl-* theme variables
const highlighter = tagHighlighter([
  { tag: [t.keyword, t.modifier, t.controlKeyword], class: "hl-keyword" },
  { tag: [t.string, t.regexp, t.special(t.string)], class: "hl-string" },
  { tag: [t.comment, t.lineComment, t.blockComment], class: "hl-comment" },
  { tag: [t.number, t.bool, t.null, t.atom], class: "hl-number" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName)], class: "hl-fn" },
  { tag: [t.typeName, t.className, t.namespace], class: "hl-type" },
  { tag: [t.propertyName, t.attributeName, t.tagName], class: "hl-prop" },
  { tag: [t.operator, t.punctuation], class: "hl-op" },
]);

async function highlight(lang: string, code: string): Promise<string | null> {
  const description = LanguageDescription.matchLanguageName(languages, lang, true);
  if (!description) return null;
  const support = await description.load();
  const tree = support.language.parser.parse(code);
  let html = "";
  highlightCode(
    code,
    tree,
    highlighter,
    (text, classes) => {
      html += classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text);
    },
    () => {
      html += "\n";
    },
  );
  return html;
}

/**
 * Document code blocks highlighted to HTML, keyed by "language", a NUL and the code.
 * The list comes from the Rust Markdown parser, so it matches the export.
 */
export async function collectHighlights(markdown: string): Promise<Record<string, string>> {
  const items = await invoke<CodeItem[]>("list_code", { markdown });
  const result: Record<string, string> = {};
  for (const { lang, code } of items) {
    try {
      const html = await highlight(lang, code);
      if (html !== null) result[`${lang}\u0000${code}`] = html;
    } catch {
      // unknown or broken grammar: the block stays without colors
    }
  }
  return result;
}

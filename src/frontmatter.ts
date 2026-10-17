/** YAML front matter: the `---` block at the very start of a Markdown file. */
const FRONT_MATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

export interface SplitContent {
  /** YAML between the fences, or null when the file has no front matter. */
  front: string | null;
  body: string;
}

export function splitFrontMatter(content: string): SplitContent {
  const match = FRONT_MATTER.exec(content.replace(/^﻿/, ""));
  if (!match) return { front: null, body: content };
  return {
    front: match[1] ?? "",
    body: content.slice(match[0].length).replace(/^\r?\n/, ""),
  };
}

export function joinFrontMatter(front: string | null, body: string): string {
  if (front === null) return body;
  const block = front === "" ? "---\n---\n" : `---\n${front}\n---\n`;
  return body ? `${block}\n${body}` : block;
}

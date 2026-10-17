const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** http(s) and mailto links open in the system browser or mail client. */
export function isExternalLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}

/** Absolute path of a relative link such as `notes/b.md#section`, or null for anchors, other schemes and bare `#`. */
export function resolveLocalLink(
  documentPath: string,
  href: string,
): string | null {
  if (
    !href ||
    href.startsWith("#") ||
    SCHEME.test(href) ||
    href.startsWith("//")
  )
    return null;
  let target = href.split("#")[0].split("?")[0];
  if (!target) return null;
  try {
    target = decodeURIComponent(target);
  } catch {
    // keep the raw text
  }
  const separator =
    documentPath.includes("\\") && !documentPath.includes("/") ? "\\" : "/";
  const base = documentPath.split(/[\\/]/).slice(0, -1);
  const parts = /^([\\/]|[a-zA-Z]:)/.test(target) ? [] : base;
  const out: string[] = [];
  for (const part of [...parts, ...target.split(/[\\/]/)]) {
    if (part === "..") {
      if (out.length > 1) out.pop();
    } else if (part !== "." && (part !== "" || out.length === 0)) {
      out.push(part);
    }
  }
  return out.join(separator);
}

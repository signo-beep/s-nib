import type { Node, Schema } from "@milkdown/kit/prose/model";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { showToast } from "./toast";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};
const IMAGE_EXTENSIONS = Object.keys(MIME);
const NO_DOCUMENT = "Salva il documento prima di inserire immagini";

let getDocPath: () => string | null = () => null;
const blobCache = new Map<string, string>();

export function initImages(docPathGetter: () => string | null) {
  getDocPath = docPathGetter;
}

/** Libera le immagini caricate (da chiamare quando si cambia documento). */
export function clearImageCache() {
  blobCache.forEach((url) => URL.revokeObjectURL(url));
  blobCache.clear();
}

function parentDir(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

/** URL mostrabile nell'editor: i percorsi locali sono letti da Rust e serviti come blob. */
export async function proxyImageUrl(url: string): Promise<string> {
  if (/^(https?:|data:|blob:)/i.test(url)) return url;

  let local = url.replace(/^file:\/\//i, "");
  try {
    local = decodeURI(local);
  } catch {
    // percentuale non valida: usare il testo com'è
  }
  const absolute = local.startsWith("/") || /^[A-Za-z]:[\\/]/.test(local);
  const docPath = getDocPath();
  if (!absolute && !docPath) return url;

  const fullPath = absolute ? local : `${parentDir(docPath as string)}/${local}`;
  const cached = blobCache.get(fullPath);
  if (cached) return cached;

  const mime = MIME[extensionOf(fullPath)];
  if (!mime) return url;
  try {
    const bytes = await invoke<ArrayBuffer>("read_image_file", { path: fullPath });
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    blobCache.set(fullPath, blobUrl);
    return blobUrl;
  } catch {
    return url;
  }
}

function pastedName(file: File): string {
  const extension = extensionOf(file.name) || (file.type.split("/")[1] ?? "png").replace("svg+xml", "svg");
  if (file.name && !/^image\.[a-z0-9]+$/i.test(file.name)) return file.name;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `image-${stamp}.${extension}`;
}

/** Salva il file in assets/ accanto al documento e restituisce il percorso relativo. */
export async function saveImageFile(file: File): Promise<string> {
  const docPath = getDocPath();
  if (!docPath) throw new Error(NO_DOCUMENT);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return invoke<string>("save_asset", bytes, {
    headers: {
      "x-doc-dir": encodeURIComponent(parentDir(docPath)),
      "x-file-name": encodeURIComponent(pastedName(file)),
    },
  });
}

/** Per il pulsante di caricamento dei componenti immagine: errori mostrati, nessun URL se fallisce. */
export async function uploadImageFile(file: File): Promise<string> {
  try {
    return await saveImageFile(file);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), "error");
    return "";
  }
}

export function imageNode(schema: Schema, src: string, alt = ""): Node | null {
  const type = schema.nodes["image-block"] ?? schema.nodes.image;
  return type?.createAndFill({ src, alt, caption: alt }) ?? null;
}

/** Incolla o trascinamento di file: salva le immagini e restituisce i nodi da inserire. */
export async function uploadImages(files: FileList, schema: Schema): Promise<Node[]> {
  const nodes: Node[] = [];
  for (const file of Array.from(files)) {
    if (!file.type.startsWith("image/")) continue;
    try {
      const node = imageNode(schema, await saveImageFile(file));
      if (node) nodes.push(node);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
      break;
    }
  }
  return nodes;
}

/** Sceglie un file immagine e lo rende disponibile accanto al documento; null se annullato. */
export async function pickImage(): Promise<string | null> {
  const docPath = getDocPath();
  if (!docPath) {
    showToast(NO_DOCUMENT, "error");
    return null;
  }
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Immagini", extensions: IMAGE_EXTENSIONS }],
  });
  if (typeof picked !== "string") return null;
  return invoke<string>("import_asset", { src: picked, docDir: parentDir(docPath) });
}

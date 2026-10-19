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
const NO_DOCUMENT = "Save the document before inserting images";

const blobCache = new Map<string, string>();

const BLOCKED_IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="64"><rect width="320" height="64" fill="#8883"/>' +
      '<text x="12" y="38" font-family="sans-serif" font-size="14" fill="#888">Remote image blocked (File > Remote images)</text></svg>',
  );

let remoteImages = false;

export function setRemoteImages(on: boolean) {
  remoteImages = on;
}

export function remoteImagesEnabled(): boolean {
  return remoteImages;
}

/** Releases the loaded images (call when switching documents). */
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

/** Remote image downloaded by Rust (the CSP does not allow remote img-src). */
async function fetchRemote(url: string): Promise<string> {
  const cached = blobCache.get(url);
  if (cached) return cached;
  try {
    const bytes = await invoke<ArrayBuffer>("fetch_remote_image", { url });
    const blobUrl = URL.createObjectURL(new Blob([bytes]));
    blobCache.set(url, blobUrl);
    return blobUrl;
  } catch {
    return BLOCKED_IMAGE;
  }
}

/** URL the editor can display: local paths are read by Rust and served as blobs. */
export async function proxyImageUrl(url: string, docPath: string | null): Promise<string> {
  if (/^data:|^blob:/i.test(url)) return url;
  if (/^https?:/i.test(url)) return remoteImages ? fetchRemote(url) : BLOCKED_IMAGE;

  let local = url.replace(/^file:\/\//i, "");
  try {
    local = decodeURI(local);
  } catch {
    // invalid percent-encoding: use the text as is
  }
  const absolute = local.startsWith("/") || /^[A-Za-z]:[\\/]/.test(local);
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

/** Saves the file in assets/ next to the document and returns the relative path. */
export async function saveImageFile(file: File, docPath: string | null): Promise<string> {
  if (!docPath) throw new Error(NO_DOCUMENT);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return invoke<string>("save_asset", bytes, {
    headers: {
      "x-doc-dir": encodeURIComponent(parentDir(docPath)),
      "x-file-name": encodeURIComponent(pastedName(file)),
    },
  });
}

/** For the image components' upload button: errors are shown, no URL on failure. */
export async function uploadImageFile(file: File, docPath: string | null): Promise<string> {
  try {
    return await saveImageFile(file, docPath);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), "error");
    return "";
  }
}

export function imageNode(schema: Schema, src: string, alt = ""): Node | null {
  const type = schema.nodes["image-block"] ?? schema.nodes.image;
  return type?.createAndFill({ src, alt, caption: alt }) ?? null;
}

/** Paste or drop of files: saves the images and returns the nodes to insert. */
export async function uploadImages(files: FileList, schema: Schema, docPath: string | null): Promise<Node[]> {
  const nodes: Node[] = [];
  for (const file of Array.from(files)) {
    if (!file.type.startsWith("image/")) continue;
    try {
      const node = imageNode(schema, await saveImageFile(file, docPath));
      if (node) nodes.push(node);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
      break;
    }
  }
  return nodes;
}

/** Drop of files from the file manager (native paths): imports the images and returns the nodes to insert. */
export async function importImagePaths(paths: string[], schema: Schema, docPath: string | null): Promise<Node[]> {
  const images = paths.filter((path) => IMAGE_EXTENSIONS.includes(extensionOf(path)));
  if (!images.length) return [];
  if (!docPath) {
    showToast(NO_DOCUMENT, "error");
    return [];
  }
  const nodes: Node[] = [];
  for (const path of images) {
    try {
      const src = await invoke<string>("import_asset", { src: path, docDir: parentDir(docPath) });
      const node = imageNode(schema, src);
      if (node) nodes.push(node);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
      break;
    }
  }
  return nodes;
}

/** Picks an image file and makes it available next to the document; null if cancelled. */
export async function pickImage(docPath: string | null): Promise<string | null> {
  if (!docPath) {
    showToast(NO_DOCUMENT, "error");
    return null;
  }
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
  });
  if (typeof picked !== "string") return null;
  return invoke<string>("import_asset", { src: picked, docDir: parentDir(docPath) });
}

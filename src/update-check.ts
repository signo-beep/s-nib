import { getVersion } from "@tauri-apps/api/app";
import { fetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import { showToast } from "./toast";

const LATEST_URL = "https://www.ssigno.ch/downloads/latest.json";
const DOWNLOAD_PAGE = "https://www.ssigno.ch/snib";

export interface UpdateInfo {
  version: string;
  url: string;
}

let available: UpdateInfo | null = null;

function parts(version: string): number[] {
  return version.split(".").map((n) => parseInt(n, 10) || 0);
}

function isNewer(remote: string, local: string): boolean {
  const a = parts(remote);
  const b = parts(local);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** Checks the static latest.json; silent on any network or format error. */
export async function checkForUpdate(): Promise<void> {
  try {
    const response = await fetch(LATEST_URL, { method: "GET", connectTimeout: 5000 });
    if (!response.ok) return;
    const data = (await response.json()) as { version?: unknown; url?: unknown };
    if (typeof data.version !== "string" || !/^\d+(\.\d+){0,2}$/.test(data.version)) return;
    if (!isNewer(data.version, await getVersion())) return;
    const url = typeof data.url === "string" && data.url.startsWith("https://www.ssigno.ch/") ? data.url : DOWNLOAD_PAGE;
    available = { version: data.version, url };
    showToast(`Update available: s-nib ${data.version} (see About)`, "info", 8000);
  } catch {
    // Offline or server unreachable: no notice
  }
}

/** Fills the About dialog line with a link to the download page, if an update exists. */
export function renderUpdateNotice(el: HTMLElement): void {
  if (!available) {
    el.hidden = true;
    return;
  }
  const { version, url } = available;
  el.textContent = "";
  const link = document.createElement("a");
  link.href = url;
  link.textContent = `Update available: ${version}`;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    void openUrl(url);
  });
  el.append(link);
  el.hidden = false;
}

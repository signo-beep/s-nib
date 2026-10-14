import { getVersion } from "@tauri-apps/api/app";
import iconUrl from "../src-tauri/icons/128x128.png";

const dialog = document.getElementById("about-dialog") as HTMLDialogElement;
const license = document.getElementById("about-license") as HTMLDetailsElement;
const licenseText = document.getElementById("about-license-text")!;
let licenseLoaded = false;

// The full license text is bundled as a separate chunk and loaded only when it is opened
license.addEventListener("toggle", async () => {
  if (!license.open || licenseLoaded) return;
  licenseLoaded = true;
  const { default: text } = await import("../LICENSE?raw");
  licenseText.textContent = text;
});

document.getElementById("about-close")!.addEventListener("click", () => dialog.close());

export async function showAbout(): Promise<void> {
  (document.getElementById("about-icon") as HTMLImageElement).src = iconUrl;
  const version = await getVersion().catch(() => "");
  document.getElementById("about-version")!.textContent = version ? `Version ${version}` : "";
  license.open = false;
  dialog.showModal();
}

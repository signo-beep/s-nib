import { getVersion } from "@tauri-apps/api/app";

/** Short commit hash at build time, empty when git was not available. */
const COMMIT_HASH: string = __COMMIT_HASH__;

/** App version with the commit, e.g. "0.5.2 (c291db6)"; empty if the version is unknown. */
export async function versionLabel(): Promise<string> {
  const version = await getVersion().catch(() => "");
  if (!version) return "";
  return COMMIT_HASH ? `${version} (${COMMIT_HASH})` : version;
}

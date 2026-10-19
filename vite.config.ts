import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { execSync } from "node:child_process";
const host = process.env.TAURI_DEV_HOST;

/** Short hash of HEAD, with "-dirty" when tracked files have uncommitted changes; empty without git (e.g. a source tarball). */
function commitHash(): string {
  const git = (args: string) =>
    execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  try {
    return git("rev-parse --short HEAD") + (git("status --porcelain --untracked-files=no") ? "-dirty" : "");
  } catch {
    return "";
  }
}

// https://vite.dev/config/
export default defineConfig(() => ({
  define: { __COMMIT_HASH__: JSON.stringify(commitHash()) },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  build: { target: "es2022" },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));

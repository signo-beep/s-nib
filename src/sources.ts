/** A place documents come from other than the local disk (extension point, see `registerSource`). */
export interface DocSource {
  kind: string;
  /** Loads the document `key`; `version` is an opaque token handed back to `write`. */
  read(key: string): Promise<{ text: string; version: string; label: string }>;
  /** Stores the text; must reject with `SourceConflict` when `version` is no longer the current one. Returns the new version. */
  write(key: string, text: string, version: string): Promise<string>;
}

/** Thrown by `DocSource.write` when the stored version is no longer the one the pane loaded. */
export class SourceConflict extends Error {}

/** The remote document a pane is bound to; a pane with one has no file path. */
export interface RemoteDoc {
  source: DocSource;
  key: string;
  label: string;
  version: string;
}

type Opener = (kind: string, key: string, side: boolean) => Promise<void>;

const sources = new Map<string, DocSource>();
let opener: Opener | null = null;

export function registerSource(source: DocSource) {
  sources.set(source.kind, source);
}

export function getSource(kind: string): DocSource | undefined {
  return sources.get(kind);
}

/** Called once by the editor: lets a source open its documents in a pane. */
export function setRemoteOpener(fn: Opener) {
  opener = fn;
}

export async function openRemote(kind: string, key: string, side = false) {
  await opener?.(kind, key, side);
}

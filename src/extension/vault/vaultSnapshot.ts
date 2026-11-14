import type { NoteInput } from "./vaultIndex";
import type { WorkspaceIndexPatch } from "./workspaceIndexPolicy";

export interface NoteSnapshot<TUri> {
  inputs: Map<string, NoteInput>;
  uris: Map<string, TUri>;
}

/** Patch an immutable snapshot, reading only changed notes. Content updates
 * require existing readable notes; path updates can insert or remove them. */
export async function patchNoteSnapshot<TUri>(
  snapshot: NoteSnapshot<TUri>,
  patch: WorkspaceIndexPatch<TUri>,
  keyOf: (uri: TUri) => string,
  readText: (uri: TUri) => Promise<string>,
  assertCurrent: () => void
): Promise<NoteSnapshot<TUri> | undefined> {
  const inputs = new Map(snapshot.inputs);
  const uris = new Map(snapshot.uris);
  for (const uri of patch.mode === "paths" ? patch.deletedUris : []) {
    inputs.delete(keyOf(uri));
    uris.delete(keyOf(uri));
  }
  for (const uri of patch.changedUris) {
    assertCurrent();
    const key = keyOf(uri);
    if (patch.mode === "content" && !inputs.has(key)) return undefined;
    let text: string;
    try {
      text = await readText(uri);
    } catch {
      if (patch.mode === "paths") {
        // Match full builds: a vanished or unreadable file is omitted. A later
        // watcher hint can add it back without searching the workspace.
        inputs.delete(key);
        uris.delete(key);
        continue;
      }
      return undefined;
    }
    assertCurrent();
    inputs.set(key, { path: key, text });
    uris.set(key, uri);
  }
  return { inputs, uris };
}

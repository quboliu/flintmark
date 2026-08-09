import type { NoteInput } from "./vaultIndex";

export interface NoteSnapshot<TUri> {
  inputs: Map<string, NoteInput>;
  uris: Map<string, TUri>;
}

/** Patch an immutable root snapshot by reading only known content-only paths.
 * Missing/unreadable entries return undefined so the driver can reconcile full. */
export async function patchNoteSnapshot<TUri>(
  snapshot: NoteSnapshot<TUri>,
  changedUris: readonly TUri[],
  keyOf: (uri: TUri) => string,
  readText: (uri: TUri) => Promise<string>,
  assertCurrent: () => void
): Promise<NoteSnapshot<TUri> | undefined> {
  const inputs = new Map(snapshot.inputs);
  const uris = new Map(snapshot.uris);
  for (const uri of changedUris) {
    assertCurrent();
    const key = keyOf(uri);
    if (!inputs.has(key)) return undefined;
    let text: string;
    try {
      text = await readText(uri);
    } catch {
      return undefined;
    }
    assertCurrent();
    inputs.set(key, { path: key, text });
    uris.set(key, uri);
  }
  return { inputs, uris };
}

import { readFile } from "node:fs/promises";

/** Read local notes in the extension host, avoiding a file-service IPC round
 * trip for every file. Non-file schemes retain their registered provider. */
export async function readIndexFile<T extends { scheme: string; fsPath: string }>(
  uri: T,
  providerRead: (uri: T) => PromiseLike<Uint8Array>
): Promise<Uint8Array> {
  return uri.scheme === "file" ? readFile(uri.fsPath) : providerRead(uri);
}

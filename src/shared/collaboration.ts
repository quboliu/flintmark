import { ChangeSet, Text } from "@codemirror/state";
import { rebaseUpdates, type Update } from "@codemirror/collab";

/** A document-local authority. Versions count accepted updates, not VS Code events. */
export class CollaborationAuthority {
  readonly updates: Update[] = [];
  doc: Text;
  constructor(
    text: string,
    public crlf: boolean,
  ) {
    this.doc = Text.of(text.split(/\r\n?|\n/));
  }
  get version(): number {
    return this.updates.length;
  }
  prepare(version: number, updates: readonly Update[]): readonly Update[] {
    if (!Number.isInteger(version) || version < 0 || version > this.version) {
      throw new RangeError("Invalid collaboration version");
    }
    return rebaseUpdates(updates, this.updates.slice(version));
  }
  commit(updates: readonly Update[]): void {
    for (const update of updates) {
      this.doc = update.changes.apply(this.doc);
      this.updates.push(update);
    }
  }
}

export interface WireUpdate {
  clientID: string;
  changes: unknown;
}
export function encodeUpdates(updates: readonly Update[]): WireUpdate[] {
  return updates.map(({ clientID, changes }) => ({
    clientID,
    changes: changes.toJSON(),
  }));
}
export function decodeUpdates(updates: readonly WireUpdate[]): Update[] {
  return updates.map(({ clientID, changes }) => ({
    clientID,
    changes: ChangeSet.fromJSON(changes),
  }));
}

/** Only replace a waiting batch when the next message contains every update
 * from the same collaboration base. Rebased batches and divergent histories
 * must retain their original queue positions. */
export function extendsPendingUpdates(
  previous: { syncVersion: number; updates: readonly WireUpdate[] },
  next: { syncVersion: number; updates: readonly WireUpdate[] },
): boolean {
  return previous.syncVersion === next.syncVersion &&
    previous.updates.length > 0 && next.updates.length > previous.updates.length &&
    previous.updates.every((update, i) =>
      update.clientID === next.updates[i].clientID &&
      JSON.stringify(update.changes) === JSON.stringify(next.updates[i].changes),
    );
}

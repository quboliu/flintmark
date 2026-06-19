// === Document Sync Manager ===
// Implements ADR-0002: TextDocument authority with CM6 optimistic local echo.
//
// ECHO SUPPRESSION MECHANISM:
// 1. When the host applies a webview-originated edit to the TextDocument via
//    WorkspaceEdit, it calls markSuppressNext(uri) BEFORE applying.
// 2. The WorkspaceEdit triggers exactly one onDidChangeTextDocument.
// 3. In the onDidChangeTextDocument handler, shouldSuppress(uri) consumes one
//    pending mark and returns true, so the host does NOT echo the change back
//    to the webview that just sent it.
// 4. Only genuinely external changes (file modified on disk, another editor,
//    undo/redo commands) find no pending mark → shouldSuppress returns false
//    and they are sent back to the webview for reconciliation.
//
// WHY A COUNTER PER URI (not a Set):
//   Under fast/burst typing several "edit" messages can be marked before their
//   individual change events drain. A Set would collapse N marks into one
//   membership, yet N change events still fire — so N-1 of our own edits would
//   leak back to the webview as "external" applyEdit and be re-applied at stale
//   offsets (content corruption / cursor jumps). A per-URI COUNTER matches one
//   suppression to each self-originated change event, which is correct under
//   bursts. (See ADR-0002; full version-based validation is a later hardening.)
//
// This is safe without locks because VS Code processes all extension-host
// events sequentially on a single event loop.

export class DocumentSyncManager {
  /** Per-URI count of self-originated edits whose change event is still pending. */
  private pending: Map<string, number> = new Map();

  /**
   * Mark that one upcoming onDidChangeTextDocument for this URI is our own and
   * should be suppressed. Call BEFORE applying a webview-originated WorkspaceEdit.
   */
  markSuppressNext(uri: string): void {
    this.pending.set(uri, (this.pending.get(uri) ?? 0) + 1);
  }

  /**
   * Consume one pending mark for this URI. Returns true (suppress) if this
   * change event is an echo of one of our own webview edits.
   */
  shouldSuppress(uri: string): boolean {
    const count = this.pending.get(uri) ?? 0;
    if (count <= 0) return false;
    if (count === 1) this.pending.delete(uri);
    else this.pending.set(uri, count - 1);
    return true;
  }

  /**
   * Roll back one pending mark for this URI. Call when an applyEdit did NOT
   * apply (returned false) or produced no change, so no change event will
   * arrive to consume the mark — otherwise the mark would leak and wrongly
   * suppress the next genuinely-external change.
   */
  cancelSuppress(uri: string): void {
    const count = this.pending.get(uri) ?? 0;
    if (count <= 1) this.pending.delete(uri);
    else this.pending.set(uri, count - 1);
  }

  /** Clear all pending suppression marks (e.g. on extension deactivate). */
  dispose(): void {
    this.pending.clear();
  }
}

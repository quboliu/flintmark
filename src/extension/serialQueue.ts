// Serial task queue, keyed (ADR-0002 data-integrity guard).
//
// Fast typing in the webview produces many "edit" messages whose offsets are
// computed against the webview's optimistic-ahead document. applyEdit is async;
// if two edits for the same document were in flight at once their offsets would
// race and corrupt/reorder the text (the real "EDITED" -> "ETD" bug). This queue
// runs tasks strictly ONE AT A TIME PER KEY, in enqueue order, so each edit sees
// the document with every prior edit already applied. Tasks for DIFFERENT keys
// (different documents) are independent and may overlap. A task that rejects does
// NOT break the chain — the next task still runs (a failed edit must not wedge
// the document). Safe without locks: the extension host is single-threaded, so
// the only concern is async interleaving, which the promise chain serializes.
export class SerialQueue {
  private chains = new Map<string, Promise<unknown>>();

  /**
   * Append `task` to `key`'s chain. Resolves/rejects with the task's result once
   * it has run after all previously-enqueued tasks for the same key.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    // `.catch` so one task's rejection does not poison the chain for the next.
    const next = prev.catch(() => undefined).then(task);
    this.chains.set(key, next);
    return next;
  }

  /** Resolves when the current tail for `key` settles (for flush / tests). */
  idle(key: string): Promise<unknown> {
    return this.chains.get(key) ?? Promise.resolve();
  }

  /** Drop all chains (e.g. on dispose). In-flight tasks still settle. */
  clear(): void {
    this.chains.clear();
  }
}

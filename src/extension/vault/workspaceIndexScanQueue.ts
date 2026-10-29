/** Serialize scans per index/root, discarding superseded work before it starts. */
export class WorkspaceIndexScanQueue {
  private readonly flights = new Map<string, Promise<void>>();

  async run(key: string, isCurrent: () => boolean, scan: () => Promise<void>): Promise<void> {
    const previous = this.flights.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (isCurrent()) await scan();
    });
    this.flights.set(key, next);
    try {
      await next;
    } finally {
      if (this.flights.get(key) === next) this.flights.delete(key);
    }
  }
}

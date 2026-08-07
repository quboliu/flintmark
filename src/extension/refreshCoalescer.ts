/**
 * Coalesces a burst with a short trailing debounce and a maximum wait. Normal
 * typing therefore causes one scan after the user pauses, while continuous
 * input still publishes periodically instead of starving the sidebar forever.
 */
export class RefreshCoalescer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private latest: (() => void) | undefined;
  private windowStartedAt: number | undefined;

  constructor(
    private readonly delayMs: number,
    private readonly maxDelayMs: number = delayMs * 4
  ) {}

  schedule(callback: () => void): void {
    this.latest = callback;
    const now = Date.now();
    if (this.windowStartedAt === undefined) this.windowStartedAt = now;
    if (this.timer !== undefined) clearTimeout(this.timer);
    const maxRemaining = Math.max(
      0,
      this.windowStartedAt + this.maxDelayMs - now
    );
    const wait = Math.min(this.delayMs, maxRemaining);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.windowStartedAt = undefined;
      const run = this.latest;
      this.latest = undefined;
      run?.();
    }, wait);
  }

  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.latest = undefined;
    this.windowStartedAt = undefined;
  }
}

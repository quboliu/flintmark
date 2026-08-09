export interface BatchControl {
  assertCurrent: () => void;
  yieldNow: () => Promise<void>;
}

/** Ordered, fixed-concurrency batch map with explicit cancellation and
 * macrotask boundaries. Unlike an unbounded Promise.all, at most batchSize
 * mapper calls are in flight. */
export async function mapInCooperativeBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  mapper: (item: T) => Promise<R>,
  control: BatchControl
): Promise<R[]> {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("batchSize must be a positive integer");
  }
  const output: R[] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    control.assertCurrent();
    output.push(...(await Promise.all(items.slice(start, start + batchSize).map(mapper))));
    control.assertCurrent();
    if (start + batchSize < items.length) await control.yieldNow();
  }
  return output;
}

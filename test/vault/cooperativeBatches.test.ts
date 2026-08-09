import assert from "node:assert";
import { mapInCooperativeBatches } from "../../src/extension/vault/cooperativeBatches";

let active = 0;
let maxActive = 0;
let yields = 0;
const result = awaitMain();

async function awaitMain(): Promise<void> {
  const values = await mapInCooperativeBatches(
    Array.from({ length: 11 }, (_, i) => i),
    3,
    async (value) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return value * 2;
    },
    {
      assertCurrent: () => undefined,
      yieldNow: async () => {
        yields++;
      },
    }
  );
  assert.equal(maxActive, 3, "pool must cap concurrent reads at the batch size");
  assert.equal(yields, 3, "eleven items in four batches yield between each batch");
  assert.deepEqual(values, Array.from({ length: 11 }, (_, i) => i * 2));
  console.log("  ✓ fixed-concurrency batches preserve order and yield between batches");
}

void result.catch((error) => {
  console.error("  ✗ cooperative batch test\n      " + (error as Error).stack);
  process.exit(1);
});

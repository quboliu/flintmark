// Pure-logic test for the keyed serial queue — the concurrent-edit corruption
// guard (ADR-0002). Runs in Node, no VS Code. Async, so it uses its own awaited
// runner instead of the synchronous `test()` the other suites use.
import assert from "node:assert";
import { SerialQueue } from "../../src/extension/serialQueue";

let failed = 0;
const cases: { name: string; fn: () => Promise<void> }[] = [];
const test = (name: string, fn: () => Promise<void>) => cases.push({ name, fn });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("runs tasks for one key strictly in enqueue order, never overlapping", async () => {
  const q = new SerialQueue();
  const order: number[] = [];
  let running = 0;
  let maxConcurrent = 0;
  const ps: Promise<void>[] = [];
  for (let i = 0; i < 12; i++) {
    // DECREASING delays: if these ran concurrently the later (shorter) tasks
    // would finish first and `order` would be scrambled. Serial => 0..11 in order.
    const delay = 24 - i * 2;
    ps.push(
      q.run("doc", async () => {
        running++;
        maxConcurrent = Math.max(maxConcurrent, running);
        await sleep(delay);
        order.push(i);
        running--;
      })
    );
  }
  await Promise.all(ps);
  assert.deepEqual(order, [...Array(12).keys()], "tasks must complete in enqueue order");
  assert.equal(maxConcurrent, 1, "no two tasks for the same key may overlap");
});

test("a rejecting task does NOT break the chain (a failed edit can't wedge the doc)", async () => {
  const q = new SerialQueue();
  const order: number[] = [];
  q.run("doc", async () => {
    order.push(1);
    throw new Error("boom");
  }).catch(() => undefined); // caller's failure is isolated
  await q.run("doc", async () => {
    order.push(2);
  });
  assert.deepEqual(order, [1, 2], "the task after a throwing one still runs, in order");
});

test("run() resolves with the task's value and propagates its rejection", async () => {
  const q = new SerialQueue();
  assert.equal(await q.run("k", async () => 42), 42, "resolves with the task result");
  await assert.rejects(
    q.run("k", async () => {
      throw new Error("nope");
    }),
    /nope/,
    "a task rejection surfaces to its own caller"
  );
  // ...and the chain still works afterwards.
  assert.equal(await q.run("k", async () => 7), 7, "chain usable after a rejection");
});

test("different keys are independent — a slow doc does not block another", async () => {
  const q = new SerialQueue();
  let slowDone = false;
  const slow = q.run("a", async () => {
    await sleep(40);
    slowDone = true;
  });
  // "b" must run without waiting for the slow "a".
  await q.run("b", async () => {
    assert.equal(slowDone, false, "key b ran while key a was still in flight");
  });
  await slow;
  assert.equal(slowDone, true);
});

test("idle() awaits the current tail for a key", async () => {
  const q = new SerialQueue();
  let done = false;
  q.run("a", async () => {
    await sleep(20);
    done = true;
  });
  await q.idle("a");
  assert.equal(done, true, "idle resolves only after the queued task settles");
  // idle on an unknown key resolves immediately.
  await q.idle("never-used");
});

(async () => {
  for (const c of cases) {
    try {
      await c.fn();
      console.log("  ✓ " + c.name);
    } catch (e) {
      failed++;
      console.error("  ✗ " + c.name + "\n      " + (e as Error).message);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} serialQueue test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll serialQueue tests passed");
})();

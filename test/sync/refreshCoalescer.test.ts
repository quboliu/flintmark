import assert from "node:assert";
import { RefreshCoalescer } from "../../src/extension/refreshCoalescer";

let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log("  ✓ " + name);
  } catch (error) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (error as Error).message);
  }
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function run(): Promise<void> {
  await test("a burst runs once with the latest document callback", async () => {
    const coalescer = new RefreshCoalescer(15);
    const seen: number[] = [];
    coalescer.schedule(() => seen.push(1));
    coalescer.schedule(() => seen.push(2));
    coalescer.schedule(() => seen.push(3));
    await wait(40);
    assert.deepEqual(seen, [3]);
  });

  await test("cancel prevents a stale document refresh after a tab switch", async () => {
    const coalescer = new RefreshCoalescer(15);
    let ran = false;
    coalescer.schedule(() => {
      ran = true;
    });
    coalescer.cancel();
    await wait(40);
    assert.equal(ran, false);
  });

  await test("a later window still publishes while editing continues", async () => {
    const coalescer = new RefreshCoalescer(10);
    let runs = 0;
    coalescer.schedule(() => runs++);
    await wait(25);
    coalescer.schedule(() => runs++);
    await wait(25);
    assert.equal(runs, 2);
  });

  await test("continuous rescheduling cannot starve the sidebar", async () => {
    const coalescer = new RefreshCoalescer(15, 35);
    let runs = 0;
    for (let index = 0; index < 6; index++) {
      coalescer.schedule(() => runs++);
      await wait(8);
    }
    assert.ok(runs >= 1, "the maximum wait should publish during continuous input");
    coalescer.cancel();
  });

  if (failed > 0) {
    console.error(`\n${failed} refresh coalescer test(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log("refresh coalescer tests passed");
  }
}

void run();

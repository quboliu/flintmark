import assert from "node:assert";
import { WorkspaceIndexScanQueue } from "../../src/extension/vault/workspaceIndexScanQueue";

async function main(): Promise<void> {
  const queue = new WorkspaceIndexScanQueue();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let generation = 1;
  let active = 0;
  let peak = 0;
  const ran: number[] = [];
  const first = queue.run("note:root", () => generation === 1, async () => {
    active++; peak = Math.max(peak, active); ran.push(1); entered();
    await gate;
    active--;
  });
  await started;
  generation = 2;
  const stale = queue.run("note:root", () => generation === 2, async () => { ran.push(2); });
  generation = 3;
  const latest = queue.run("note:root", () => generation === 3, async () => {
    active++; peak = Math.max(peak, active); ran.push(3); active--;
  });
  let otherRootRan = false;
  await queue.run("image:other", () => true, async () => { otherRootRan = true; });
  assert.equal(otherRootRan, true, "unrelated indexes must not wait for a busy root");
  assert.deepEqual(ran, [1], "new scans wait for the running search to settle");
  release();
  await Promise.all([first, stale, latest]);
  assert.equal(peak, 1);
  assert.deepEqual(ran, [1, 3], "superseded queued scans must never start");
  await assert.rejects(queue.run("note:root", () => true, async () => { throw Error("scan failure"); }));
  await queue.run("note:root", () => true, async () => { ran.push(4); });
  assert.deepEqual(ran, [1, 3, 4], "a failed scan must not poison later requests");
  console.log("  ✓ scans serialize per root, skip stale work and recover from failures");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });

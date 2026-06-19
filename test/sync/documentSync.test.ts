// Pure-logic test for the echo-suppression state machine (docs/adr/0002).
// Runs in Node with no VS Code — the bottom of the docs/05 test pyramid.
import assert from "node:assert";
import { DocumentSyncManager } from "../../src/extension/documentSync";

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (e as Error).message);
  }
}

const URI = "file:///a.md";

test("single self-edit is suppressed exactly once", () => {
  const m = new DocumentSyncManager();
  m.markSuppressNext(URI);
  assert.equal(m.shouldSuppress(URI), true, "our own change should be suppressed");
  assert.equal(m.shouldSuppress(URI), false, "a later external change must NOT be suppressed");
});

test("burst typing: N marks suppress N events (the regression we fixed)", () => {
  const m = new DocumentSyncManager();
  m.markSuppressNext(URI);
  m.markSuppressNext(URI);
  m.markSuppressNext(URI);
  assert.equal(m.shouldSuppress(URI), true);
  assert.equal(m.shouldSuppress(URI), true);
  assert.equal(m.shouldSuppress(URI), true, "all 3 self-edits suppressed (a Set would leak 2 here)");
  assert.equal(m.shouldSuppress(URI), false, "the next external change passes through");
});

test("cancelSuppress rolls back a mark when applyEdit produced no event", () => {
  const m = new DocumentSyncManager();
  m.markSuppressNext(URI);
  m.cancelSuppress(URI); // applyEdit returned false → no change event will arrive
  assert.equal(m.shouldSuppress(URI), false, "external change must not be wrongly suppressed");
});

test("per-URI isolation", () => {
  const m = new DocumentSyncManager();
  const A = "file:///a.md";
  const B = "file:///b.md";
  m.markSuppressNext(A);
  assert.equal(m.shouldSuppress(B), false, "B is unaffected by A's pending mark");
  assert.equal(m.shouldSuppress(A), true);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll sync tests passed");

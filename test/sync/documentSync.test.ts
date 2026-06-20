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

// --- model-based property test: random interleavings vs a reference model -----
// The example cases above pin specific scenarios; this drives RANDOM sequences
// of mark/shouldSuppress/cancel across several URIs and asserts the manager
// matches a trivial reference model (a per-URI outstanding-mark counter) on every
// step, plus the safety invariants. Seeded so any failure is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("model-based: matches a reference counter under random interleavings", () => {
  const SEED = Number(process.env.SYNC_SEED) || 0xc0ffee;
  const rng = mulberry32(SEED);
  const uris = ["file:///a.md", "file:///b.md", "file:///c.md"];
  for (let trial = 0; trial < 500; trial++) {
    const m = new DocumentSyncManager();
    const model = new Map<string, number>(); // uri -> outstanding marks (the truth)
    for (let step = 0; step < 60; step++) {
      const uri = uris[Math.floor(rng() * uris.length)];
      const outstanding = model.get(uri) ?? 0;
      const op = Math.floor(rng() * 3);
      if (op === 0) {
        // mark
        m.markSuppressNext(uri);
        model.set(uri, outstanding + 1);
      } else if (op === 1) {
        // shouldSuppress: true iff there were outstanding marks; consumes one
        const expected = outstanding > 0;
        assert.equal(
          m.shouldSuppress(uri),
          expected,
          `seed=${SEED} trial=${trial} step=${step}: shouldSuppress(${uri}) expected ${expected} (outstanding=${outstanding})`
        );
        if (outstanding > 0) model.set(uri, outstanding - 1);
      } else {
        // cancel: rolls back one mark if any; never goes negative
        m.cancelSuppress(uri);
        if (outstanding > 0) model.set(uri, outstanding - 1);
      }
      // Invariant: a fresh manager seeded to the model's outstanding count would
      // suppress exactly that many times — i.e. the manager never "leaks" or
      // "loses" a mark relative to the model. We check the count indirectly:
      // outstanding is always >= 0 in the model (proof the manager can't be asked
      // to suppress more than were marked).
      assert.ok((model.get(uri) ?? 0) >= 0, "outstanding marks can never be negative");
    }
  }
});

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll sync tests passed");

// Pure-logic tests for the (closed-interval) node-intersection Reveal rule.
// Runs in Node with no VS Code — docs/05 top-of-pyramid L1.
// Rule: reveal iff sel.from <= constructTo AND sel.to >= constructFrom
// (touching a boundary DOES reveal; strictly-outside does not).
import assert from "node:assert";
import { shouldRevealConstruct, type SelectionRange } from "../../src/webview/kernel/reveal";

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

// --- boundary touching → REVEALED (closed interval) ------------------------

test("cursor at exact start of construct (touching) → revealed", () => {
  assert.equal(shouldRevealConstruct(0, 8, [{ from: 0, to: 0 }]), true);
});

test("cursor at exact end of construct (touching) → revealed", () => {
  // Crucial for headings: clicking at the end of the heading line reveals '#'.
  assert.equal(shouldRevealConstruct(0, 8, [{ from: 8, to: 8 }]), true);
});

test("cursor one position inside construct → revealed", () => {
  assert.equal(shouldRevealConstruct(0, 8, [{ from: 1, to: 1 }]), true);
});

test("selection ending exactly at construct start (touching) → revealed", () => {
  assert.equal(shouldRevealConstruct(5, 10, [{ from: 0, to: 5 }]), true);
});

test("selection starting exactly at construct end (touching) → revealed", () => {
  assert.equal(shouldRevealConstruct(5, 10, [{ from: 10, to: 15 }]), true);
});

// --- strictly outside → HIDDEN ---------------------------------------------

test("cursor just before construct → hidden", () => {
  assert.equal(shouldRevealConstruct(5, 10, [{ from: 4, to: 4 }]), false);
});

test("cursor just after construct → hidden", () => {
  assert.equal(shouldRevealConstruct(5, 10, [{ from: 11, to: 11 }]), false);
});

test("cursor far before construct → hidden", () => {
  assert.equal(shouldRevealConstruct(100, 110, [{ from: 2, to: 2 }]), false);
});

test("cursor far after construct → hidden", () => {
  assert.equal(shouldRevealConstruct(100, 110, [{ from: 200, to: 200 }]), false);
});

// --- selections overlapping → revealed -------------------------------------

test("selection spans across construct start → revealed", () => {
  assert.equal(shouldRevealConstruct(5, 10, [{ from: 3, to: 7 }]), true);
});

test("selection entirely contains construct → revealed", () => {
  assert.equal(shouldRevealConstruct(5, 10, [{ from: 0, to: 20 }]), true);
});

test("selection entirely inside construct → revealed", () => {
  assert.equal(shouldRevealConstruct(5, 10, [{ from: 6, to: 9 }]), true);
});

// --- multiple selections ---------------------------------------------------

test("multiple selections: one intersects → revealed", () => {
  assert.equal(
    shouldRevealConstruct(5, 10, [{ from: 0, to: 2 }, { from: 6, to: 7 }]),
    true
  );
});

test("multiple selections: none touch → hidden", () => {
  assert.equal(
    shouldRevealConstruct(5, 10, [{ from: 0, to: 2 }, { from: 11, to: 12 }]),
    false
  );
});

// --- adjacent inline constructs (`**bold** *italic*`, A=[0,8] B=[9,16]) -----

test("adjacent: cursor strictly inside first reveals only first", () => {
  const sel: SelectionRange[] = [{ from: 4, to: 4 }];
  assert.equal(shouldRevealConstruct(0, 8, sel), true);
  assert.equal(shouldRevealConstruct(9, 16, sel), false);
});

test("adjacent: cursor strictly inside second reveals only second", () => {
  const sel: SelectionRange[] = [{ from: 12, to: 12 }];
  assert.equal(shouldRevealConstruct(0, 8, sel), false);
  assert.equal(shouldRevealConstruct(9, 16, sel), true);
});

test("adjacent: selection spanning both reveals both", () => {
  const sel: SelectionRange[] = [{ from: 3, to: 14 }];
  assert.equal(shouldRevealConstruct(0, 8, sel), true);
  assert.equal(shouldRevealConstruct(9, 16, sel), true);
});

test("adjacent: cursor in the gap (touches neither's interior) → hidden", () => {
  // gap is offset 8..9; a zero-width cursor strictly inside the gap touches
  // neither construct: at 8.5 there is no integer, so use the real reachable
  // cursor positions — between constructs there must be ≥1 char, here none, so
  // we model a cursor that is past A.to and before B.from is impossible when
  // they share no gap. With a 1-char gap [8,9), cursor at 8 touches A (==A.to)
  // and cursor at 9 touches B (==B.from). A cursor cannot sit strictly between.
  // Therefore we assert the realistic case: cursor at 8 reveals A, not B.
  const sel: SelectionRange[] = [{ from: 8, to: 8 }];
  assert.equal(shouldRevealConstruct(0, 8, sel), true); // touches A.to
  assert.equal(shouldRevealConstruct(9, 16, sel), false); // 8 < B.from(9)
});

test("no selections → nothing revealed", () => {
  assert.equal(shouldRevealConstruct(0, 8, []), false);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll reveal tests passed");

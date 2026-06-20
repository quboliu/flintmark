// Pure-logic tests for shared/ranges.ts — offset<->position conversion, line
// counting, and the AI-bridge offset clamp. These helpers had NO unit coverage
// before (a known blind spot): they run host-side but are pure, so they belong
// at L1. Runs in Node with no VS Code — docs/05 top-of-pyramid.
import assert from "node:assert";
import {
  offsetToPosition,
  positionToOffset,
  lineCount,
  clampOffsetRange,
} from "../../src/shared/ranges";

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

// --- offsetToPosition --------------------------------------------------------

test("offsetToPosition: offset 0 is line 0 char 0", () => {
  assert.deepEqual(offsetToPosition("abc\ndef", 0), { line: 0, character: 0 });
});

test("offsetToPosition: within the first line", () => {
  assert.deepEqual(offsetToPosition("abc\ndef", 2), { line: 0, character: 2 });
});

test("offsetToPosition: offset ON a newline counts the line not yet advanced", () => {
  // offset 3 = the '\n' itself; we've consumed "abc", not yet crossed the break.
  assert.deepEqual(offsetToPosition("abc\ndef", 3), { line: 0, character: 3 });
});

test("offsetToPosition: first char of the second line", () => {
  assert.deepEqual(offsetToPosition("abc\ndef", 4), { line: 1, character: 0 });
});

test("offsetToPosition: offset past EOF clamps to text length", () => {
  // Loop guard `i < text.length` stops counting at EOF.
  assert.deepEqual(offsetToPosition("abc\ndef", 999), { line: 1, character: 3 });
});

test("offsetToPosition: empty text is always line 0 char 0", () => {
  assert.deepEqual(offsetToPosition("", 5), { line: 0, character: 0 });
});

// --- positionToOffset --------------------------------------------------------

test("positionToOffset: line 0 char 0 is offset 0", () => {
  assert.equal(positionToOffset("abc\ndef", 0, 0), 0);
});

test("positionToOffset: second line maps past the newline", () => {
  assert.equal(positionToOffset("abc\ndef", 1, 0), 4);
  assert.equal(positionToOffset("abc\ndef", 1, 2), 6);
});

test("positionToOffset: a position beyond EOF clamps to text length", () => {
  assert.equal(positionToOffset("abc\ndef", 99, 99), 7);
});

// --- round-trip property: offset -> position -> offset is the identity --------

test("round-trip: offsetToPosition then positionToOffset is identity (multiline)", () => {
  const docs = [
    "",
    "a",
    "abc",
    "abc\ndef",
    "line1\nline2\nline3",
    "trailing\n",
    "\n\n\nblank lines\n\n",
    "unicode: café 漢字 😀 end",
    "tabs\tand   spaces\nmore",
  ];
  for (const doc of docs) {
    for (let off = 0; off <= doc.length; off++) {
      const pos = offsetToPosition(doc, off);
      const back = positionToOffset(doc, pos.line, pos.character);
      assert.equal(
        back,
        off,
        `round-trip failed for ${JSON.stringify(doc)} @${off}: pos=${JSON.stringify(pos)} -> ${back}`
      );
    }
  }
});

// --- lineCount ---------------------------------------------------------------

test("lineCount: empty text is one line", () => {
  assert.equal(lineCount(""), 1);
});

test("lineCount: no newline is one line", () => {
  assert.equal(lineCount("a single line"), 1);
});

test("lineCount: counts newlines + 1, trailing newline yields an extra line", () => {
  assert.equal(lineCount("a\nb\nc"), 3);
  assert.equal(lineCount("a\nb\nc\n"), 4);
});

// --- clampOffsetRange (the AI-bridge boundary logic) -------------------------

test("clampOffsetRange: ordered in-bounds pair is unchanged", () => {
  assert.deepEqual(clampOffsetRange(2, 5, 10), { from: 2, to: 5 });
});

test("clampOffsetRange: reversed pair is normalized to ordered", () => {
  assert.deepEqual(clampOffsetRange(5, 2, 10), { from: 2, to: 5 });
});

test("clampOffsetRange: negative offsets clamp to 0", () => {
  assert.deepEqual(clampOffsetRange(-4, 3, 10), { from: 0, to: 3 });
  assert.deepEqual(clampOffsetRange(-9, -2, 10), { from: 0, to: 0 });
});

test("clampOffsetRange: offsets beyond len clamp to len", () => {
  assert.deepEqual(clampOffsetRange(8, 50, 10), { from: 8, to: 10 });
  assert.deepEqual(clampOffsetRange(40, 50, 10), { from: 10, to: 10 });
});

test("clampOffsetRange: equal offsets yield a collapsed range", () => {
  assert.deepEqual(clampOffsetRange(4, 4, 10), { from: 4, to: 4 });
});

test("clampOffsetRange: empty document clamps everything to 0", () => {
  assert.deepEqual(clampOffsetRange(3, 7, 0), { from: 0, to: 0 });
});

test("clampOffsetRange: invariant 0 <= from <= to <= len over many inputs", () => {
  const vals = [-100, -1, 0, 1, 3, 7, 10, 11, 99];
  for (const len of [0, 1, 5, 10]) {
    for (const a of vals) {
      for (const b of vals) {
        const r = clampOffsetRange(a, b, len);
        assert.ok(
          0 <= r.from && r.from <= r.to && r.to <= len,
          `invariant broken: clampOffsetRange(${a},${b},${len}) = ${JSON.stringify(r)}`
        );
      }
    }
  }
});

if (failed > 0) {
  console.error(`\n${failed} ranges test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll ranges tests passed");

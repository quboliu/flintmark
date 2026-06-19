// Pure-logic tests for the decoration plan computation (kernel/decorate.ts).
// Runs in Node with no VS Code — docs/05 top-of-pyramid L1.
import assert from "node:assert";
import {
  computeDecorationPlan,
  type ConstructInfo,
} from "../../src/webview/kernel/decorate";
import type { SelectionRange } from "../../src/webview/kernel/reveal";

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

// ---------------------------------------------------------------------------
// Helper to build ConstructInfo for tests
// ---------------------------------------------------------------------------

function bold(
  start: number,
  textLen: number,
  markerLen = 2
): ConstructInfo {
  // `**text**`: construct at [start, start+2 + textLen+2]
  const constructFrom = start;
  const constructTo = start + markerLen + textLen + markerLen;
  return {
    from: constructFrom,
    to: constructTo,
    type: "strong",
    markers: [
      {
        from: start,
        to: start + markerLen,
        constructFrom,
        constructTo,
      },
      {
        from: start + markerLen + textLen,
        to: constructTo,
        constructFrom,
        constructTo,
      },
    ],
  };
}

function italic(
  start: number,
  textLen: number,
  markerLen = 1
): ConstructInfo {
  const constructFrom = start;
  const constructTo = start + markerLen + textLen + markerLen;
  return {
    from: constructFrom,
    to: constructTo,
    type: "emphasis",
    markers: [
      {
        from: start,
        to: start + markerLen,
        constructFrom,
        constructTo,
      },
      {
        from: start + markerLen + textLen,
        to: constructTo,
        constructFrom,
        constructTo,
      },
    ],
  };
}

function heading(
  start: number,
  level: number,
  textLen: number
): ConstructInfo {
  // `## Heading`: construct at [start, start+level+1+textLen]
  const markerLen = level + 1; // ## + space
  const constructFrom = start;
  const constructTo = start + markerLen + textLen;
  return {
    from: constructFrom,
    to: constructTo,
    type: "heading",
    headingLevel: level,
    markers: [
      {
        from: start,
        to: start + markerLen,
        constructFrom,
        constructTo,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// No selections → all markers hidden, heading styles output
// ---------------------------------------------------------------------------

test("no selections → all markers hidden", () => {
  const c = [bold(0, 4), heading(10, 2, 7)];
  const plan = computeDecorationPlan(c, []);
  assert.equal(plan.hiddenRanges.length, 3, "bold has 2 markers + heading has 1 = 3");
  assert.equal(plan.hiddenRanges[0].from, 0);
  assert.equal(plan.hiddenRanges[0].to, 2);
  assert.equal(plan.hiddenRanges[1].from, 6);
  assert.equal(plan.hiddenRanges[1].to, 8);
  assert.equal(plan.hiddenRanges[2].from, 10);
  assert.equal(plan.hiddenRanges[2].to, 13); // start + level+1 = 10 + 3 = 13
});

test("no selections → heading styles still output", () => {
  const c = [heading(0, 1, 5), heading(10, 3, 4)];
  const plan = computeDecorationPlan(c, []);
  assert.equal(plan.headingStyles.length, 2);
  assert.equal(plan.headingStyles[0].level, 1);
  assert.equal(plan.headingStyles[0].atOffset, 0);
  assert.equal(plan.headingStyles[1].level, 3);
  assert.equal(plan.headingStyles[1].atOffset, 10);
});

// ---------------------------------------------------------------------------
// Cursor inside construct → revealed → markers NOT hidden
// ---------------------------------------------------------------------------

test("cursor inside construct → markers revealed (not hidden)", () => {
  const c = [bold(0, 4)];
  // cursor at position 3 (inside "bold" text, between markers)
  const sel: SelectionRange[] = [{ from: 3, to: 3 }];
  const plan = computeDecorationPlan(c, sel);
  assert.equal(plan.hiddenRanges.length, 0, "bold should be revealed → no hidden markers");
});

test("cursor one position inside construct → markers revealed", () => {
  const c = [bold(0, 4)];
  // cursor at position 1 (one past the opening `*`, inside construct)
  const sel: SelectionRange[] = [{ from: 1, to: 1 }];
  const plan = computeDecorationPlan(c, sel);
  assert.equal(plan.hiddenRanges.length, 0);
});

test("cursor at exact construct start (touching) → markers revealed", () => {
  const c = [bold(0, 4)];
  // cursor at 0 == construct start — closed interval reveals on touch
  const sel: SelectionRange[] = [{ from: 0, to: 0 }];
  const plan = computeDecorationPlan(c, sel);
  assert.equal(plan.hiddenRanges.length, 0, "cursor touching boundary → revealed");
});

// ---------------------------------------------------------------------------
// Cursor outside construct → markers hidden
// ---------------------------------------------------------------------------

test("cursor outside construct → markers hidden", () => {
  const c = [bold(0, 4)];
  const sel: SelectionRange[] = [{ from: 10, to: 10 }];
  const plan = computeDecorationPlan(c, sel);
  assert.equal(plan.hiddenRanges.length, 2, "both markers hidden");
  assert.equal(plan.hiddenRanges[0].from, 0);
  assert.equal(plan.hiddenRanges[0].to, 2);
  assert.equal(plan.hiddenRanges[1].from, 6);
  assert.equal(plan.hiddenRanges[1].to, 8);
});

// ---------------------------------------------------------------------------
// Heading markers revealed when cursor is inside heading line
// ---------------------------------------------------------------------------

test("cursor inside heading text → heading markers revealed", () => {
  const c = [heading(0, 2, 7)]; // `## Heading` at [0, 10]
  const sel: SelectionRange[] = [{ from: 5, to: 5 }]; // cursor in "Heading"
  const plan = computeDecorationPlan(c, sel);
  assert.equal(plan.hiddenRanges.length, 0, "heading marker should be revealed");
  assert.equal(plan.headingStyles.length, 1, "heading style always output");
});

test("cursor in heading marker itself → revealed", () => {
  const c = [heading(0, 2, 7)];
  const sel: SelectionRange[] = [{ from: 1, to: 1 }]; // cursor in `#`
  const plan = computeDecorationPlan(c, sel);
  assert.equal(plan.hiddenRanges.length, 0);
});

test("cursor outside heading → heading marker hidden", () => {
  const c = [heading(0, 2, 7)];
  const sel: SelectionRange[] = [{ from: 20, to: 20 }];
  const plan = computeDecorationPlan(c, sel);
  assert.equal(plan.hiddenRanges.length, 1, "heading marker hidden");
  assert.equal(plan.hiddenRanges[0].from, 0);
  assert.equal(plan.hiddenRanges[0].to, 3); // markerLen = level+1 = 3
  assert.equal(plan.headingStyles.length, 1, "heading style still output");
});

// ---------------------------------------------------------------------------
// Two adjacent constructs on same line
// ---------------------------------------------------------------------------

test("adjacent constructs: cursor in first → only first revealed", () => {
  // `**bold** *italic*` → bold at [0,8], italic at [9,16]
  const c = [bold(0, 4), italic(9, 5)];
  const sel: SelectionRange[] = [{ from: 4, to: 4 }]; // cursor in bold
  const plan = computeDecorationPlan(c, sel);
  assert.equal(plan.hiddenRanges.length, 2, "only italic markers hidden (2 markers)");
  // italic's marker 1 is at [9, 10], marker 2 at [15, 16]
  assert.equal(plan.hiddenRanges[0].from, 9);
  assert.equal(plan.hiddenRanges[0].to, 10);
  assert.equal(plan.hiddenRanges[1].from, 15);
  assert.equal(plan.hiddenRanges[1].to, 16);
});

test("adjacent constructs: selection across both → both revealed", () => {
  const c = [bold(0, 4), italic(9, 5)];
  const sel: SelectionRange[] = [{ from: 3, to: 14 }];
  const plan = computeDecorationPlan(c, sel);
  assert.equal(plan.hiddenRanges.length, 0, "both constructs intersected by selection");
});

// ---------------------------------------------------------------------------
// Multiple selections
// ---------------------------------------------------------------------------

test("multiple selections: one in bold, one outside → bold revealed, heading hidden", () => {
  const c = [bold(0, 4), heading(15, 1, 5)];
  const sel: SelectionRange[] = [
    { from: 3, to: 3 },    // cursor in bold
    { from: 25, to: 25 },  // cursor outside both
  ];
  const plan = computeDecorationPlan(c, sel);
  assert.equal(plan.hiddenRanges.length, 1, "heading marker hidden (1 marker)");
  assert.equal(plan.hiddenRanges[0].from, 15);
  assert.equal(plan.hiddenRanges[0].to, 17); // markerLen = level+1 = 2
});

// ---------------------------------------------------------------------------
// Empty constructs list
// ---------------------------------------------------------------------------

test("empty constructs → empty plan", () => {
  const plan = computeDecorationPlan([], []);
  assert.equal(plan.hiddenRanges.length, 0);
  assert.equal(plan.headingStyles.length, 0);
});

test("empty constructs with selections → empty plan", () => {
  const sel: SelectionRange[] = [{ from: 5, to: 5 }];
  const plan = computeDecorationPlan([], sel);
  assert.equal(plan.hiddenRanges.length, 0);
  assert.equal(plan.headingStyles.length, 0);
});

// ---------------------------------------------------------------------------
// Heading level validation
// ---------------------------------------------------------------------------

test("heading level 1 produces correct styling instruction", () => {
  const c = [heading(0, 1, 5)];
  const plan = computeDecorationPlan(c, []);
  assert.equal(plan.headingStyles[0].level, 1);
});

test("heading level 6 produces correct styling instruction", () => {
  const c = [heading(0, 6, 5)];
  const plan = computeDecorationPlan(c, []);
  assert.equal(plan.headingStyles[0].level, 6);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll decorate tests passed");

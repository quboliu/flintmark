// L1 unit tests for the heading-fold range math (src/webview/view/folding.ts):
// headingLevel + sectionFoldEndLine. Pure, no CM6/DOM.
import assert from "node:assert";
import { headingLevel, sectionFoldEndLine } from "../../src/webview/view/folding";

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

test("headingLevel: 1-6 for #..######, 0 otherwise", () => {
  assert.equal(headingLevel("# x"), 1);
  assert.equal(headingLevel("### x"), 3);
  assert.equal(headingLevel("###### x"), 6);
  assert.equal(headingLevel("####### x"), 0); // 7 # is not a heading
  assert.equal(headingLevel("#notspace"), 0);
  assert.equal(headingLevel("text"), 0);
});

test("fold: section stops before the next same-level heading", () => {
  const lines = ["# A", "body", "more", "# B", "x"];
  assert.equal(sectionFoldEndLine(lines, 0, 1), 2); // includes body+more, not # B
});

test("fold: a deeper subheading stays inside the section", () => {
  const lines = ["# A", "body", "## Sub", "deep", "# B"];
  assert.equal(sectionFoldEndLine(lines, 0, 1), 3); // through 'deep', before # B
});

test("fold: subsection stops at the next same-or-higher heading", () => {
  const lines = ["## A", "body", "# B"];
  assert.equal(sectionFoldEndLine(lines, 0, 2), 1);
});

test("fold: # inside fenced code does not end the section", () => {
  const lines = ["# A", "```", "# in fence", "```", "body"];
  assert.equal(sectionFoldEndLine(lines, 0, 1), 4);
});

test("fold: trailing blank lines are not swallowed", () => {
  const lines = ["# A", "body", "", ""];
  assert.equal(sectionFoldEndLine(lines, 0, 1), 1);
});

test("fold: heading with no body → returns startIdx (nothing to fold)", () => {
  const lines = ["# A", "# B"];
  assert.equal(sectionFoldEndLine(lines, 0, 1), 0);
});

test("fold: last section runs to the end of the doc", () => {
  const lines = ["# A", "one", "two"];
  assert.equal(sectionFoldEndLine(lines, 0, 1), 2);
});

if (failed > 0) {
  console.error(`\n${failed} folding test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll folding tests passed");

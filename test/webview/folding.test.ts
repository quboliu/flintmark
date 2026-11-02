// L1 unit tests for the heading-fold range math (src/webview/view/folding.ts):
// Range behavior and immutable-document cache invalidation. No DOM required.
import assert from "node:assert";
import { EditorState, Text } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { headingFoldRange, headingLevel, sectionFoldEndLine } from "../../src/webview/view/folding";

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

const markdownState = (doc: string): EditorState =>
  EditorState.create({ doc, extensions: [markdown()] });

test("fold range: nested sections, fences, whitespace and EOF retain exact offsets", () => {
  const fixtures = [
    "# A\nbody\n## Sub\ndeep\n\n# B\nlast\n\n",
    "# A\n~~~js\n# not a heading\n~~~\nbody\n# B",
    "# A\n\x60\x60\x60cpp\n#include <stdio.h>\n\x60\x60\x60\n\n# B\n",
    "# Empty\n\n# Also empty",
    "# A\nbody\n\n  \n\t",
    "# Only heading",
    "# A\n\x60\x60\x60\n# unclosed fence\nbody",
    "# A\n😀 emoji\n## Sub\nUnicode café\n# B\nend",
  ];
  for (const doc of fixtures) {
    const state = markdownState(doc), lines = doc.split("\n");
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(\x60\x60\x60|~~~)/.test(lines[i])) inFence = !inFence;
      const level = headingLevel(lines[i]);
      if (!level) continue;
      const line = state.doc.line(i + 1);
      if (inFence) { assert.equal(headingFoldRange(state, line.from), null); continue; }
      const end = sectionFoldEndLine(lines, i, level);
      const expected = end === i ? null : { from: line.to, to: state.doc.line(end + 1).to };
      assert.deepEqual(headingFoldRange(state, line.from), expected);
      assert.deepEqual(headingFoldRange(state, line.from), expected);
    }
  }
});

test("fold range: a cached section is invalidated when its document changes", () => {
  const initial = markdownState("# A\nbody\n# B\nend");
  assert.deepEqual(headingFoldRange(initial, 0), { from: 3, to: 8 });
  const selectionOnly = initial.update({ selection: { anchor: 5 } }).state;
  assert.deepEqual(headingFoldRange(selectionOnly, 0), { from: 3, to: 8 });
  const changed = selectionOnly.update({ changes: { from: 9, to: 12, insert: "## Nested" } }).state;
  assert.deepEqual(headingFoldRange(changed, 0), { from: 3, to: changed.doc.length });
  assert.deepEqual(headingFoldRange(initial, 0), { from: 3, to: 8 });
});

test("fold range: plain text and fenced headings never become fold starts", () => {
  const state = markdownState("body\n\x60\x60\x60md\n# example\ntext\n\x60\x60\x60\n# Real\nvalue");
  assert.equal(headingFoldRange(state, 0), null);
  assert.equal(headingFoldRange(state, state.doc.line(3).from), null);
  assert.deepEqual(headingFoldRange(state, state.doc.line(6).from), { from: state.doc.line(6).to, to: state.doc.length });
});

test("fold range: refreshing hundreds of headings does not copy the whole document per heading", () => {
  for (const headings of [210, 420, 840]) {
    const sections = Array.from({ length: headings }, (_, i) => "## Section " + i + "\nbody\n\n");
    let state = markdownState(sections.join(""));
    assert.ok(ensureSyntaxTree(state, state.doc.length, 10000));
    state = state.update({}).state;
    assert.equal(syntaxTree(state).length, state.doc.length);
    const starts: number[] = [];
    let offset = 0;
    for (const section of sections) { starts.push(offset); offset += section.length; }
    const originalLine = Text.prototype.line;
    let numberedLineReads = 0;
    Text.prototype.line = function (number) { numberedLineReads++; return originalLine.call(this, number); };
    try {
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i < starts.length; i++) {
          const from = starts[i] + sections[i].indexOf("\n");
          assert.deepEqual(headingFoldRange(state, starts[i]), { from, to: from + 5 });
        }
      }
    } finally { Text.prototype.line = originalLine; }
    assert.ok(numberedLineReads <= state.doc.lines * 4,
      "Whole-document line reads must not grow with every heading: " + numberedLineReads);
  }
});

if (failed > 0) {
  console.error(`\n${failed} folding test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll folding tests passed");

// Headless test of the CM6 decoration builder against a REAL EditorState +
// @lezer/markdown tree (no DOM, runs in Node). Catches runtime errors that
// tsc and the pure-kernel tests cannot — notably the RangeSetBuilder add-order
// crash that the extension-host integration test does not exercise.
import assert from "node:assert";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { ofmMarkdown } from "../../src/webview/kernel/obsidianSyntax";
import type { DecorationSet } from "@codemirror/view";
import { buildDecorations } from "../../src/webview/view/markdownDecorations";

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

function mkState(doc: string, cursor: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [ofmMarkdown()], // exact same parser config as the app
  });
  // Force a full parse so syntaxTree() is complete for these tiny docs.
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

/** Ranges that hide source (replace decorations: width>0 with no CSS class). */
function hiddenRanges(set: DecorationSet): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const it = set.iter();
  while (it.value) {
    const cls = (it.value.spec as { class?: string }).class;
    if (it.from < it.to && !cls) out.push({ from: it.from, to: it.to });
    it.next();
  }
  return out;
}

const hides = (set: DecorationSet, from: number) =>
  hiddenRanges(set).some((r) => r.from === from);

test("large files skip Live Preview rendering (perf safety)", () => {
  // > 2M chars: 16-char unit × 140k ≈ 2.24M, above LARGE_FILE_CHARS (2M).
  const big = "# Heading\n\n" + "lorem **ipsum** ".repeat(140000);
  const set = buildDecorations(mkState(big, 0));
  assert.equal(set.size, 0, "no decorations above the large-file threshold");
});

test("rich doc builds without throwing (regression: decoration add-order)", () => {
  const doc = "# Title\n\n**bold** and `code` and ~~strike~~\n";
  const set = buildDecorations(mkState(doc, doc.length));
  assert.ok(set.size > 0, "expected some decorations");
});

test("heading marker hidden when cursor is outside the heading", () => {
  const doc = "# Hello\n\nbody text"; // cursor in body is strictly outside heading
  const set = buildDecorations(mkState(doc, doc.length));
  assert.ok(hides(set, 0), "the '# ' marker (offset 0) should be hidden");
});

test("heading marker revealed when cursor is inside the heading", () => {
  const doc = "# Hello";
  const set = buildDecorations(mkState(doc, 3)); // cursor inside "Hello"
  assert.ok(!hides(set, 0), "the '# ' marker should be revealed (not hidden)");
});

test("bold markers hidden outside, revealed inside (node-intersection)", () => {
  const doc = "x **bold** y";
  const open = doc.indexOf("**"); // opening EmphasisMark offset
  const inside = doc.indexOf("bold") + 1;

  const outside = buildDecorations(mkState(doc, 0));
  assert.ok(hides(outside, open), "bold markers hidden when cursor outside");

  const within = buildDecorations(mkState(doc, inside));
  assert.ok(!hides(within, open), "bold markers revealed when cursor inside");
});

test("heading line styling is applied (ofm-heading-1)", () => {
  const doc = "# Hello";
  const set = buildDecorations(mkState(doc, doc.length));
  let hasLine = false;
  const it = set.iter();
  while (it.value) {
    const cls = (it.value.spec as { class?: string }).class;
    if (it.from === 0 && it.to === 0 && cls?.includes("ofm-heading-1")) hasLine = true;
    it.next();
  }
  assert.ok(hasLine, "expected an ofm-heading-1 line decoration on the heading");
});

test("strikethrough (GFM) hidden outside, revealed inside", () => {
  const doc = "a ~~gone~~ b";
  const open = doc.indexOf("~~");
  const inside = doc.indexOf("gone") + 1;
  assert.ok(hides(buildDecorations(mkState(doc, 0)), open), "strike markers hidden outside");
  assert.ok(
    !hides(buildDecorations(mkState(doc, inside)), open),
    "strike markers revealed inside"
  );
});

if (failed > 0) {
  console.error(`\n${failed} decoration test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll decoration tests passed");

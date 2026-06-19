// Headless tests: $inline$ / $$display$$ become MathWidget replace-decorations
// with the right TeX + display flag. (toDOM/KaTeX render needs a DOM, so we only
// inspect the widget's properties here — rendering is covered by the e2e.)
import assert from "node:assert";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import type { DecorationSet } from "@codemirror/view";
import { buildDecorations } from "../../src/webview/view/markdownDecorations";
import { ofmMarkdown } from "../../src/webview/kernel/obsidianSyntax";
import { MathWidget } from "../../src/webview/view/widgets/mathWidget";

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
    extensions: [ofmMarkdown()],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function maths(set: DecorationSet): { tex: string; display: boolean }[] {
  const out: { tex: string; display: boolean }[] = [];
  const it = set.iter();
  while (it.value) {
    const w = (it.value.spec as { widget?: unknown }).widget;
    if (w instanceof MathWidget) out.push({ tex: w.tex, display: w.display });
    it.next();
  }
  return out;
}

test("inline $...$ becomes an inline MathWidget", () => {
  const doc = "energy $e=mc^2$ here";
  const m = maths(buildDecorations(mkState(doc, doc.length)));
  assert.equal(m.length, 1);
  assert.equal(m[0].tex, "e=mc^2");
  assert.equal(m[0].display, false);
});

test("display $$...$$ becomes a block MathWidget", () => {
  const doc = "$$a+b$$ x";
  const m = maths(buildDecorations(mkState(doc, doc.length)));
  assert.equal(m.length, 1);
  assert.equal(m[0].tex, "a+b");
  assert.equal(m[0].display, true);
});

test("math shows raw source while the cursor is inside", () => {
  const doc = "energy $e=mc^2$ here";
  assert.equal(maths(buildDecorations(mkState(doc, 10))).length, 0);
});

test("currency ($5 and $6) is not treated as math", () => {
  const doc = "Costs $5 and $6 today";
  assert.equal(maths(buildDecorations(mkState(doc, doc.length))).length, 0);
});

if (failed > 0) {
  console.error(`\n${failed} math test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll math tests passed");

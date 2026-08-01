// Headless tests: $inline$, $$same-line display$$, and delimiter-line display
// math become MathWidget replacements with the right TeX + display flag.
// (toDOM/KaTeX render needs a DOM, so rendering is covered by the e2e.)
import assert from "node:assert";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import type { DecorationSet } from "@codemirror/view";
import {
  buildBlockWidgets,
  buildDecorations,
} from "../../src/webview/view/markdownDecorations";
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

function mathRanges(
  set: DecorationSet
): { from: number; to: number; tex: string; display: boolean; block: boolean }[] {
  const out: {
    from: number;
    to: number;
    tex: string;
    display: boolean;
    block: boolean;
  }[] = [];
  const it = set.iter();
  while (it.value) {
    const w = (it.value.spec as { widget?: unknown }).widget;
    if (w instanceof MathWidget) {
      out.push({
        from: it.from,
        to: it.to,
        tex: w.tex,
        display: w.display,
        block: (it.value.spec as { block?: boolean }).block === true,
      });
    }
    it.next();
  }
  return out;
}

const ATTENTION_PIPELINE = [
  "$$",
  "QK^\\top",
  "\\quad\\longrightarrow\\quad",
  "\\frac{QK^\\top}{\\sqrt{d_h}}+M",
  "\\quad\\longrightarrow\\quad",
  "\\operatorname{softmax}\\!\\left(\\frac{QK^\\top}{\\sqrt{d_h}}+M\\right)",
  "$$",
].join("\n");

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

test("line-delimited display math preserves the target attention formula", () => {
  const doc = `before\n\n${ATTENTION_PIPELINE}\n\nafter`;
  const blocks = mathRanges(buildBlockWidgets(mkState(doc, doc.length)));
  assert.deepEqual(blocks, [
    {
      from: 8,
      to: 8 + ATTENTION_PIPELINE.length,
      tex: ATTENTION_PIPELINE.split("\n").slice(1, -1).join("\n"),
      display: true,
      block: true,
    },
  ]);
});

test("line-delimited display math becomes a block MathWidget", () => {
  const doc = `before\n\n${ATTENTION_PIPELINE}\n\nafter`;
  const m = maths(buildBlockWidgets(mkState(doc, doc.length)));
  assert.deepEqual(m, [
    {
      tex: ATTENTION_PIPELINE.split("\n").slice(1, -1).join("\n"),
      display: true,
    },
  ]);
});

test("line-delimited display math reveals raw source while the cursor is inside", () => {
  const doc = `before\n\n${ATTENTION_PIPELINE}\n\nafter`;
  const cursor = doc.indexOf("softmax");
  assert.equal(maths(buildBlockWidgets(mkState(doc, cursor))).length, 0);
});

test("line-delimited display math ignores fenced code and unclosed delimiters", () => {
  const fenced = `\`\`\`text\n${ATTENTION_PIPELINE}\n\`\`\``;
  assert.equal(maths(buildBlockWidgets(mkState(fenced, fenced.length))).length, 0);
  const unclosed = "$$\nx+y\n\n# following markdown";
  assert.equal(maths(buildBlockWidgets(mkState(unclosed, unclosed.length))).length, 0);
});

test("multiple line-delimited formulas each keep an independent block widget", () => {
  const tall = [
    "$$",
    "\\begin{aligned}",
    "a &= b + c \\\\",
    "d &= \\frac{e}{f}",
    "\\end{aligned}",
    "$$",
  ].join("\n");
  const doc = `before\n\n${ATTENTION_PIPELINE}\n\nbetween\n\n${tall}\n\nafter`;
  const m = mathRanges(buildBlockWidgets(mkState(doc, doc.length)));
  assert.equal(m.length, 2);
  assert.ok(m.every((entry) => entry.display && entry.block));
  assert.match(m[0].tex, /softmax/);
  assert.match(m[1].tex, /begin\{aligned\}/);
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

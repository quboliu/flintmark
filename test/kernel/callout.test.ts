// Headless tests for callout box decorations + horizontal rule widget, against
// a real @lezer/markdown (GFM) tree. No DOM.
import assert from "node:assert";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { ofmMarkdown } from "../../src/webview/kernel/obsidianSyntax";
import type { DecorationSet } from "@codemirror/view";
import { buildDecorations } from "../../src/webview/view/markdownDecorations";
import { HrWidget } from "../../src/webview/view/widgets/hrWidget";

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

function lineClasses(set: DecorationSet): string[] {
  const out: string[] = [];
  const it = set.iter();
  while (it.value) {
    if (it.from === it.to) {
      const c = (it.value.spec as { class?: string }).class;
      if (c) out.push(c);
    }
    it.next();
  }
  return out;
}

function hasHrWidget(set: DecorationSet): boolean {
  const it = set.iter();
  while (it.value) {
    if ((it.value.spec as { widget?: unknown }).widget instanceof HrWidget) return true;
    it.next();
  }
  return false;
}

function hiddenEmptyCount(set: DecorationSet): number {
  let n = 0;
  const it = set.iter();
  while (it.value) {
    const s = it.value.spec as { class?: string; widget?: unknown };
    if (it.from < it.to && !s.class && !s.widget) n++;
    it.next();
  }
  return n;
}

test("callout blockquote gets boxed lines + hides the [!type] marker", () => {
  const doc = "intro\n\n> [!warning] Heads up\n> be careful\n\nend";
  const set = buildDecorations(mkState(doc, doc.length)); // cursor in "end"
  const classes = lineClasses(set);
  assert.equal(
    classes.filter((c) => c.includes("ofm-callout-warning")).length,
    2,
    "both callout lines should be boxed"
  );
  assert.ok(
    classes.some((c) => c.includes("ofm-callout-title")),
    "title line should be styled"
  );
  assert.ok(hiddenEmptyCount(set) >= 1, "the [!warning] marker should be hidden");
});

test("plain blockquote is NOT treated as a callout", () => {
  const doc = "> just a normal quote\n> second line";
  const set = buildDecorations(mkState(doc, doc.length));
  assert.equal(
    lineClasses(set).filter((c) => c.includes("ofm-callout")).length,
    0,
    "no callout styling on a plain blockquote"
  );
});

test("horizontal rule becomes an HrWidget when the cursor is away", () => {
  const doc = "a\n\n---\n\nb";
  assert.ok(hasHrWidget(buildDecorations(mkState(doc, doc.length))));
});

test("horizontal rule shows source when the cursor is on it", () => {
  const doc = "a\n\n---\n\nb";
  const onRule = doc.indexOf("---") + 1;
  assert.ok(!hasHrWidget(buildDecorations(mkState(doc, onRule))));
});

test("fenced code block: bg on all lines, fences collapsed, ends rounded (not editing)", () => {
  const doc = "t\n\n```js\nconst x = 1;\nconst y = 2;\n```\n\nafter";
  const lc = lineClasses(buildDecorations(mkState(doc, doc.length)));
  assert.equal(
    lc.filter((c) => c.includes("HyperMD-codeblock-bg")).length,
    4,
    "background on all 4 lines (```js + 2 code + ```)"
  );
  assert.equal(
    lc.filter((c) => c.includes("ofm-codeblock-fence")).length,
    2,
    "both ``` fence lines collapsed when not editing"
  );
  assert.ok(lc.some((c) => c.includes("ofm-codeblock-begin")), "first code line rounded");
  assert.ok(lc.some((c) => c.includes("ofm-codeblock-end")), "last code line rounded");
});

test("frontmatter is dimmed; its --- are not rules but a body --- still is", () => {
  const doc = "---\ntitle: Hi\ntags: [a, b]\n---\n\n# Body\n\n---\n\nend";
  const set = buildDecorations(mkState(doc, doc.length));
  const fm = lineClasses(set).filter((c) => c.includes("ofm-frontmatter"));
  assert.equal(fm.length, 4, "4 dimmed frontmatter lines");
  assert.ok(hasHrWidget(set), "the body-level --- still renders as a rule");
});

if (failed > 0) {
  console.error(`\n${failed} callout test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll callout tests passed");

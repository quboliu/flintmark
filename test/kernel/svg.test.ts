// Headless coverage for inline SVG HTMLBlock rendering. The widget's DOM
// sanitizer runs in the browser; these tests cover the parser seam and the
// deliberately narrow "single SVG block" detector.
import assert from "node:assert";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import type { DecorationSet } from "@codemirror/view";
import { ofmMarkdown } from "../../src/webview/kernel/obsidianSyntax";
import { buildBlockWidgets } from "../../src/webview/view/markdownDecorations";
import { SvgWidget, extractSvgFromHtmlBlock } from "../../src/webview/view/widgets/svgWidget";
import { TableWidget } from "../../src/webview/view/widgets/tableWidget";

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

function widgets<T>(
  set: DecorationSet,
  cls: new (...args: any[]) => T
): { from: number; to: number; widget: T }[] {
  const out: { from: number; to: number; widget: T }[] = [];
  const it = set.iter();
  while (it.value) {
    const w = (it.value.spec as { widget?: unknown }).widget;
    if (w instanceof cls) out.push({ from: it.from, to: it.to, widget: w });
    it.next();
  }
  return out;
}

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10"><rect x="0" y="0" width="20" height="10" fill="red" /></svg>';

test("extractSvgFromHtmlBlock accepts a plain div-wrapped single svg", () => {
  assert.equal(extractSvgFromHtmlBlock(`<div>\n${SVG}\n</div>\n`), SVG);
});

test("extractSvgFromHtmlBlock accepts a bare single svg", () => {
  assert.equal(extractSvgFromHtmlBlock(`${SVG}\n`), SVG);
});

test("extractSvgFromHtmlBlock rejects surrounding text and multiple svg roots", () => {
  assert.equal(extractSvgFromHtmlBlock(`<div>\ncaption\n${SVG}\n</div>`), null);
  assert.equal(extractSvgFromHtmlBlock(`<div>\n${SVG}\n${SVG}\n</div>`), null);
  assert.equal(extractSvgFromHtmlBlock(`<div class="figure">\n${SVG}\n</div>`), null);
});

test("HTMLBlock renders as SvgWidget when the cursor is outside", () => {
  const doc = `intro\n\n<div>\n${SVG}\n</div>\n\nend\n`;
  const found = widgets(buildBlockWidgets(mkState(doc, doc.length)), SvgWidget);
  assert.equal(found.length, 1);
  assert.equal(found[0].widget.source, SVG);
});

test("HTMLBlock reveals raw SVG source while the cursor is inside", () => {
  const doc = `intro\n\n<div>\n${SVG}\n</div>\n\nend\n`;
  const found = widgets(buildBlockWidgets(mkState(doc, doc.indexOf("rect"))), SvgWidget);
  assert.equal(found.length, 0);
});

test("SVG-like text inside a fenced code block is not rendered", () => {
  const doc = "```html\n<div>\n" + SVG + "\n</div>\n```\n";
  const found = widgets(buildBlockWidgets(mkState(doc, doc.length)), SvgWidget);
  assert.equal(found.length, 0);
});

test("tables inside raw HTML blocks do not create overlapping table widgets", () => {
  const doc = "<div>\n| A | B |\n| --- | --- |\n</div>\n";
  const found = widgets(buildBlockWidgets(mkState(doc, doc.length)), TableWidget);
  assert.equal(found.length, 0);
});

if (failed > 0) {
  console.error(`\n${failed} svg test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll svg tests passed");

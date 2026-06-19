// Headless tests for Obsidian inline syntax decorations (tag / highlight /
// wikilink) against the real ofmMarkdown() parser. No DOM.
import assert from "node:assert";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import type { DecorationSet } from "@codemirror/view";
import { buildDecorations } from "../../src/webview/view/markdownDecorations";
import { ofmMarkdown } from "../../src/webview/kernel/obsidianSyntax";

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

type Mark = { from: number; to: number; attrs?: Record<string, string> };
function marks(set: DecorationSet, cls: string): Mark[] {
  const out: Mark[] = [];
  const it = set.iter();
  while (it.value) {
    const s = it.value.spec as { class?: string; attributes?: Record<string, string> };
    // token match: a mark may carry several classes (e.g. "ofm-tag cm-hashtag").
    if (it.from < it.to && s.class && s.class.split(/\s+/).includes(cls))
      out.push({ from: it.from, to: it.to, attrs: s.attributes });
    it.next();
  }
  return out;
}
function hiddenCount(set: DecorationSet): number {
  let n = 0;
  const it = set.iter();
  while (it.value) {
    const s = it.value.spec as { class?: string; widget?: unknown };
    if (it.from < it.to && !s.class && !s.widget) n++;
    it.next();
  }
  return n;
}

test("#tag is styled as a pill over the whole tag", () => {
  const doc = "see #project/alpha here";
  const tags = marks(buildDecorations(mkState(doc, doc.length)), "ofm-tag");
  assert.equal(tags.length, 1);
  assert.equal(tags[0].from, doc.indexOf("#"));
  assert.equal(tags[0].to, doc.indexOf(" here"));
});

test("==highlight== styles content and hides == markers when cursor away", () => {
  const doc = "==important== x";
  const set = buildDecorations(mkState(doc, doc.length)); // cursor in " x"
  const hl = marks(set, "ofm-highlight");
  assert.equal(hl.length, 1);
  assert.equal(hl[0].from, 2);
  assert.equal(hl[0].to, 11);
  assert.ok(hiddenCount(set) >= 2, "both == delimiters hidden");
});

test("==highlight== shows == when cursor is inside", () => {
  const doc = "==important== x";
  const set = buildDecorations(mkState(doc, 5)); // cursor inside
  assert.equal(hiddenCount(set), 0, "delimiters revealed");
});

test("[[Page]] renders as an internal link to Page", () => {
  const doc = "[[Page]] x";
  const links = marks(buildDecorations(mkState(doc, doc.length)), "ofm-internal-link");
  assert.equal(links.length, 1);
  assert.equal(links[0].attrs?.["data-ofm-link"], "Page");
});

test("[[Page|Show]] shows alias, links to Page", () => {
  const doc = "[[Page|Show]] x";
  const set = buildDecorations(mkState(doc, doc.length));
  const links = marks(set, "ofm-internal-link");
  assert.equal(links.length, 1);
  assert.equal(links[0].attrs?.["data-ofm-link"], "Page");
  // the visible label is "Show"
  assert.equal(doc.slice(links[0].from, links[0].to), "Show");
});

if (failed > 0) {
  console.error(`\n${failed} obsidian-syntax test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll obsidian-syntax tests passed");

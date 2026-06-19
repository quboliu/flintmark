// Headless tests for image rendering: ![alt](src) becomes an ImageWidget whose
// src comes from the host-provided imageMap (or passes through for remote URLs).
import assert from "node:assert";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import type { DecorationSet } from "@codemirror/view";
import { buildDecorations } from "../../src/webview/view/markdownDecorations";
import { ofmMarkdown } from "../../src/webview/kernel/obsidianSyntax";
import {
  ImageWidget,
  imageMapField,
  setImageMap,
} from "../../src/webview/view/widgets/imageWidget";

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

function mkState(doc: string, cursor: number, map: Record<string, string>): EditorState {
  let state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [ofmMarkdown(), imageMapField],
  });
  state = state.update({ effects: setImageMap.of(map) }).state;
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function imageWidgets(
  set: DecorationSet
): { from: number; to: number; src: string; alt: string }[] {
  const out: { from: number; to: number; src: string; alt: string }[] = [];
  const it = set.iter();
  while (it.value) {
    const w = (it.value.spec as { widget?: unknown }).widget;
    if (w instanceof ImageWidget) out.push({ from: it.from, to: it.to, src: w.src, alt: w.alt });
    it.next();
  }
  return out;
}

test("local image renders with the host-resolved src (cursor away)", () => {
  const doc = "![logo](pic.png) x";
  const set = buildDecorations(
    mkState(doc, doc.length, { "pic.png": "vscode-webview://abc/pic.png" })
  );
  const imgs = imageWidgets(set);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].alt, "logo");
  assert.equal(imgs[0].src, "vscode-webview://abc/pic.png");
});

test("image shows raw source while the cursor is inside it", () => {
  const doc = "![logo](pic.png) x";
  const set = buildDecorations(mkState(doc, 3, { "pic.png": "x" }));
  assert.equal(imageWidgets(set).length, 0);
});

test("remote image passes through without a map entry", () => {
  const doc = "![](https://example.com/a.png) x";
  const imgs = imageWidgets(buildDecorations(mkState(doc, doc.length, {})));
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].src, "https://example.com/a.png");
});

if (failed > 0) {
  console.error(`\n${failed} image test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll image tests passed");

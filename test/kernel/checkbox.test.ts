// Headless test: task markers become CheckboxWidget replace-decorations with the
// correct checked state, against a real @lezer/markdown (GFM) tree. No DOM.
import assert from "node:assert";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { ofmMarkdown } from "../../src/webview/kernel/obsidianSyntax";
import type { DecorationSet } from "@codemirror/view";
import { buildDecorations } from "../../src/webview/view/markdownDecorations";
import { CheckboxWidget } from "../../src/webview/view/widgets/checkboxWidget";

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

function mkState(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [ofmMarkdown()],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function checkboxes(
  set: DecorationSet
): { from: number; to: number; checked: boolean }[] {
  const out: { from: number; to: number; checked: boolean }[] = [];
  const it = set.iter();
  while (it.value) {
    const w = (it.value.spec as { widget?: unknown }).widget;
    if (w instanceof CheckboxWidget) {
      out.push({ from: it.from, to: it.to, checked: w.checked });
    }
    it.next();
  }
  return out;
}

test("task markers become checkboxes with correct checked state", () => {
  const boxes = checkboxes(buildDecorations(mkState("- [ ] todo\n- [x] done")));
  assert.equal(boxes.length, 2, "expected two checkboxes");
  assert.equal(boxes[0].checked, false, "first task unchecked");
  assert.equal(boxes[1].checked, true, "second task checked");
});

test("uppercase [X] is treated as checked", () => {
  const boxes = checkboxes(buildDecorations(mkState("- [X] done")));
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].checked, true);
});

test("plain list items / text produce no checkboxes", () => {
  const boxes = checkboxes(buildDecorations(mkState("- plain item\n\njust text")));
  assert.equal(boxes.length, 0);
});

if (failed > 0) {
  console.error(`\n${failed} checkbox test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll checkbox tests passed");

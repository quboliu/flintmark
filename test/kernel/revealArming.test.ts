// Headless tests for reveal arming (see markdownDecorations.ts "Reveal arming"):
// a freshly opened document renders fully until the first user interaction;
// host-driven reveals arm explicitly; callers without the field keep the
// historic always-armed behavior.
import assert from "node:assert";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import type { DecorationSet } from "@codemirror/view";
import {
  buildDecorations,
  armRevealEffect,
  armRevealExtender,
  revealArmedField,
} from "../../src/webview/view/markdownDecorations";
import { ofmMarkdown } from "../../src/webview/kernel/obsidianSyntax";
import {
  ImageWidget,
  imageMapField,
  setImageMap,
} from "../../src/webview/view/widgets/imageWidget";
import {
  mediaMeasurementsField,
  setMediaMeasurements,
  stableMediaIdentity,
} from "../../src/webview/view/mediaMeasurements";

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

/** State with the arming field, an image whose intrinsic size is known, and
 *  the cursor inside the image (the VS Code open position for line-1 images). */
function mkState(doc: string, cursor: number, withArmingField: boolean): EditorState {
  let state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [
      ofmMarkdown(),
      imageMapField,
      mediaMeasurementsField,
      ...(withArmingField ? [revealArmedField] : []),
    ],
  });
  const resolved = [...doc.matchAll(/https?:\/\/[^)\s]+/g)].map((m) => m[0]);
  state = state.update({
    effects: [
      setImageMap.of({}),
      setMediaMeasurements.of({
        contentWidth: 600,
        fontSizePx: 16,
        dimensions: resolved.map((src) => ({
          identity: stableMediaIdentity(src),
          width: 100,
          height: 50,
        })),
      }),
    ],
  }).state;
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function imageCount(set: DecorationSet): number {
  let n = 0;
  const it = set.iter();
  while (it.value) {
    if ((it.value.spec as { widget?: unknown }).widget instanceof ImageWidget) n++;
    it.next();
  }
  return n;
}

const img = "![img](https://example.com/a.png)";

test("unarmed: cursor inside a line-1 image still renders (open behavior)", () => {
  const doc = `${img}\ntext`;
  assert.equal(imageCount(buildDecorations(mkState(doc, 0, true))), 1);
});

test("unarmed: cursor inside the image paragraph renders with cursor away too", () => {
  const doc = `${img}\ntext`;
  assert.equal(imageCount(buildDecorations(mkState(doc, doc.length, true))), 1);
});

test("armed: cursor inside the image reveals raw source", () => {
  const doc = `${img}\ntext`;
  let state = mkState(doc, 0, true);
  state = state.update({ effects: armRevealEffect.of(null) }).state;
  assert.equal(imageCount(buildDecorations(state)), 0);
});

test("armed: cursor away still renders (standard reveal rule unchanged)", () => {
  const doc = `${img}\ntext`;
  let state = mkState(doc, doc.length, true);
  state = state.update({ effects: armRevealEffect.of(null) }).state;
  assert.equal(imageCount(buildDecorations(state)), 1);
});

test("without the arming field: legacy always-armed behavior", () => {
  const doc = `${img}\ntext`;
  assert.equal(imageCount(buildDecorations(mkState(doc, 0, false))), 0);
});

test("arming is sticky (later transactions keep it armed)", () => {
  const doc = `${img}\ntext`;
  let state = mkState(doc, 0, true);
  state = state.update({ effects: armRevealEffect.of(null) }).state;
  state = state.update({ changes: { from: doc.length, insert: "!" } }).state;
  assert.equal(state.field(revealArmedField), true);
  assert.equal(imageCount(buildDecorations(state)), 0);
});

// --- transaction extender ---------------------------------------------------

function mkExtenderState(doc: string): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: 0 },
    extensions: [
      ofmMarkdown(),
      revealArmedField,
      EditorState.transactionExtender.of(armRevealExtender),
    ],
  });
}

test("extender: a user selection arms the editor", () => {
  let state = mkExtenderState("plain text");
  assert.equal(state.field(revealArmedField), false);
  state = state.update({
    selection: { anchor: 3 },
    userEvent: "select.pointer",
  }).state;
  assert.equal(state.field(revealArmedField), true);
});

test("extender: typing arms the editor", () => {
  let state = mkExtenderState("plain text");
  state = state.update({
    changes: { from: 5, insert: "!" },
    userEvent: "input.type",
  }).state;
  assert.equal(state.field(revealArmedField), true);
});

test("extender: host-originated changes without userEvent do not arm", () => {
  let state = mkExtenderState("plain text");
  state = state.update({ changes: { from: 0, to: 5, insert: "other" } }).state;
  assert.equal(state.field(revealArmedField), false);
});

if (failed > 0) {
  console.error(`\n${failed} reveal-arming test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll reveal-arming tests passed");

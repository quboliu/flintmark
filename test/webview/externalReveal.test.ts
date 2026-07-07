// L1 unit tests for the one-shot external reveal marker used when a native
// source selection/search hit is bridged back into Live Preview.
import assert from "node:assert";
import { EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import {
  externalRevealField,
  setExternalRevealRange,
} from "../../src/webview/view/externalReveal";

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

function mkState(doc = "alpha formatword omega"): EditorState {
  return EditorState.create({
    doc,
    extensions: [externalRevealField],
  });
}

function ranges(set: DecorationSet): { from: number; to: number; cls?: string }[] {
  const out: { from: number; to: number; cls?: string }[] = [];
  const it = set.iter();
  while (it.value) {
    out.push({
      from: it.from,
      to: it.to,
      cls: (it.value.spec as { class?: string }).class,
    });
    it.next();
  }
  return out;
}

function revealRanges(state: EditorState): { from: number; to: number; cls?: string }[] {
  return ranges(state.field(externalRevealField));
}

test("setExternalRevealRange creates the external search-hit decoration", () => {
  const start = "alpha ".length;
  const end = start + "formatword".length;
  const state = mkState().update({
    effects: setExternalRevealRange.of({ from: start, to: end }),
  }).state;

  assert.deepEqual(revealRanges(state), [
    { from: start, to: end, cls: "ofm-external-search-hit" },
  ]);
});

test("external reveal decoration maps through document edits", () => {
  const start = "alpha ".length;
  const end = start + "formatword".length;
  let state = mkState().update({
    effects: setExternalRevealRange.of({ from: start, to: end }),
  }).state;

  state = state.update({ changes: { from: 0, insert: ">>" } }).state;

  assert.deepEqual(revealRanges(state), [
    { from: start + 2, to: end + 2, cls: "ofm-external-search-hit" },
  ]);
});

test("collapsed reveal and user selection clear the marker", () => {
  const start = "alpha ".length;
  const end = start + "formatword".length;
  let state = mkState().update({
    effects: setExternalRevealRange.of({ from: start, to: end }),
  }).state;

  state = state.update({
    effects: setExternalRevealRange.of({ from: start, to: start }),
  }).state;
  assert.equal(revealRanges(state).length, 0, "collapsed reveal clears");

  state = mkState().update({
    effects: setExternalRevealRange.of({ from: start, to: end }),
  }).state;
  state = state.update({ selection: { anchor: 0 } }).state;
  assert.equal(revealRanges(state).length, 0, "user selection clears");
});

if (failed > 0) {
  console.error(`\n${failed} externalReveal test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll externalReveal tests passed");

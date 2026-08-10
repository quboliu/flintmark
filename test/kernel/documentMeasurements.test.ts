import assert from "node:assert";
import { EditorState } from "@codemirror/state";
import { FULL_DOCUMENT_LIVE_PREVIEW_CHAR_LIMIT } from "../../src/webview/view/layoutPreflight";
import {
  createDocumentMeasurementsField,
  documentMeasurementScan,
} from "../../src/webview/view/documentMeasurements";

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log("  ✓ " + name);
  } catch (error) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (error as Error).message);
  }
}

function countingField(calls: { tables: number; media: number }) {
  return createDocumentMeasurementsField({
    findTables: () => {
      calls.tables++;
      return [];
    },
    findSvgSources: () => {
      calls.media++;
      return [];
    },
  });
}

test("a keypress above the Live Preview cutoff performs no table or media scan", () => {
  const calls = { tables: 0, media: 0 };
  const field = countingField(calls);
  let state = EditorState.create({
    doc: "x".repeat(FULL_DOCUMENT_LIVE_PREVIEW_CHAR_LIMIT + 1),
    extensions: [field],
  });
  calls.tables = 0;
  calls.media = 0;
  state = state.update({ changes: { from: 1, insert: "a" } }).state;

  assert.deepEqual(calls, { tables: 0, media: 0 });
  assert.equal(documentMeasurementScan(state, field).docText, undefined);
});

test("a plain-text keypress in a small resource-free document skips full scans", () => {
  const calls = { tables: 0, media: 0 };
  const field = countingField(calls);
  let state = EditorState.create({ doc: "plain text\n", extensions: [field] });
  calls.tables = 0;
  calls.media = 0;
  state = state.update({ changes: { from: 5, insert: "x" } }).state;

  assert.ok(calls.tables <= 1, `findTableBlocks called ${calls.tables} times`);
  assert.ok(calls.media <= 1, `media full scan called ${calls.media} times`);
  assert.deepEqual(calls, { tables: 0, media: 0 });
  assert.equal(documentMeasurementScan(state, field).docText, "plainx text\n");
});

if (failed > 0) {
  console.error(`\n${failed} document measurement test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll document measurement tests passed");

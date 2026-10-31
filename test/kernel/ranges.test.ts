// Pure-logic tests for shared/ranges.ts — offset<->position conversion, line
// counting, and the AI-bridge offset clamp. These helpers had NO unit coverage
// before (a known blind spot): they run host-side but are pure, so they belong
// at L1. Runs in Node with no VS Code — docs/05 top-of-pyramid.
import assert from "node:assert";
import { EditorState } from "@codemirror/state";
import {
  offsetToPosition,
  positionToOffset,
  lineCount,
  clampOffsetRange,
  cmToHostOffset,
  hostToCmOffset,
} from "../../src/shared/ranges";

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

// --- offsetToPosition --------------------------------------------------------

test("offsetToPosition: offset 0 is line 0 char 0", () => {
  assert.deepEqual(offsetToPosition("abc\ndef", 0), { line: 0, character: 0 });
});

test("offsetToPosition: within the first line", () => {
  assert.deepEqual(offsetToPosition("abc\ndef", 2), { line: 0, character: 2 });
});

test("offsetToPosition: offset ON a newline counts the line not yet advanced", () => {
  // offset 3 = the '\n' itself; we've consumed "abc", not yet crossed the break.
  assert.deepEqual(offsetToPosition("abc\ndef", 3), { line: 0, character: 3 });
});

test("offsetToPosition: first char of the second line", () => {
  assert.deepEqual(offsetToPosition("abc\ndef", 4), { line: 1, character: 0 });
});

test("offsetToPosition: offset past EOF clamps to text length", () => {
  // Loop guard `i < text.length` stops counting at EOF.
  assert.deepEqual(offsetToPosition("abc\ndef", 999), { line: 1, character: 3 });
});

test("offsetToPosition: empty text is always line 0 char 0", () => {
  assert.deepEqual(offsetToPosition("", 5), { line: 0, character: 0 });
});

// --- positionToOffset --------------------------------------------------------

test("positionToOffset: line 0 char 0 is offset 0", () => {
  assert.equal(positionToOffset("abc\ndef", 0, 0), 0);
});

test("positionToOffset: second line maps past the newline", () => {
  assert.equal(positionToOffset("abc\ndef", 1, 0), 4);
  assert.equal(positionToOffset("abc\ndef", 1, 2), 6);
});

test("positionToOffset: a position beyond EOF clamps to text length", () => {
  assert.equal(positionToOffset("abc\ndef", 99, 99), 7);
});

// --- round-trip property: offset -> position -> offset is the identity --------

test("round-trip: offsetToPosition then positionToOffset is identity (multiline)", () => {
  const docs = [
    "",
    "a",
    "abc",
    "abc\ndef",
    "line1\nline2\nline3",
    "trailing\n",
    "\n\n\nblank lines\n\n",
    "unicode: café 漢字 😀 end",
    "tabs\tand   spaces\nmore",
  ];
  for (const doc of docs) {
    for (let off = 0; off <= doc.length; off++) {
      const pos = offsetToPosition(doc, off);
      const back = positionToOffset(doc, pos.line, pos.character);
      assert.equal(
        back,
        off,
        `round-trip failed for ${JSON.stringify(doc)} @${off}: pos=${JSON.stringify(pos)} -> ${back}`
      );
    }
  }
});

// --- lineCount ---------------------------------------------------------------

test("lineCount: empty text is one line", () => {
  assert.equal(lineCount(""), 1);
});

test("lineCount: no newline is one line", () => {
  assert.equal(lineCount("a single line"), 1);
});

test("lineCount: counts newlines + 1, trailing newline yields an extra line", () => {
  assert.equal(lineCount("a\nb\nc"), 3);
  assert.equal(lineCount("a\nb\nc\n"), 4);
});

// --- clampOffsetRange (the AI-bridge boundary logic) -------------------------

test("clampOffsetRange: ordered in-bounds pair is unchanged", () => {
  assert.deepEqual(clampOffsetRange(2, 5, 10), { from: 2, to: 5 });
});

test("clampOffsetRange: reversed pair is normalized to ordered", () => {
  assert.deepEqual(clampOffsetRange(5, 2, 10), { from: 2, to: 5 });
});

test("clampOffsetRange: negative offsets clamp to 0", () => {
  assert.deepEqual(clampOffsetRange(-4, 3, 10), { from: 0, to: 3 });
  assert.deepEqual(clampOffsetRange(-9, -2, 10), { from: 0, to: 0 });
});

test("clampOffsetRange: offsets beyond len clamp to len", () => {
  assert.deepEqual(clampOffsetRange(8, 50, 10), { from: 8, to: 10 });
  assert.deepEqual(clampOffsetRange(40, 50, 10), { from: 10, to: 10 });
});

test("clampOffsetRange: equal offsets yield a collapsed range", () => {
  assert.deepEqual(clampOffsetRange(4, 4, 10), { from: 4, to: 4 });
});

test("clampOffsetRange: empty document clamps everything to 0", () => {
  assert.deepEqual(clampOffsetRange(3, 7, 0), { from: 0, to: 0 });
});

test("clampOffsetRange: invariant 0 <= from <= to <= len over many inputs", () => {
  const vals = [-100, -1, 0, 1, 3, 7, 10, 11, 99];
  for (const len of [0, 1, 5, 10]) {
    for (const a of vals) {
      for (const b of vals) {
        const r = clampOffsetRange(a, b, len);
        assert.ok(
          0 <= r.from && r.from <= r.to && r.to <= len,
          `invariant broken: clampOffsetRange(${a},${b},${len}) = ${JSON.stringify(r)}`
        );
      }
    }
  }
});

// --- CodeMirror (LF) <-> host (CRLF) offsets ---------------------------------
// CodeMirror counts a CRLF as 1 character, the TextDocument as 2.

const CRLF = "a\r\nb\r\n";

test("cmToHostOffset: each earlier CRLF adds one", () => {
  assert.equal(cmToHostOffset(CRLF, 0), 0);
  assert.equal(cmToHostOffset(CRLF, 1), 1); // before the first break
  assert.equal(cmToHostOffset(CRLF, 2), 3); // start of "b"
  assert.equal(cmToHostOffset(CRLF, 3), 4); // before the second break
  assert.equal(cmToHostOffset(CRLF, 4), 6); // end of document
});

test("cmToHostOffset: clamps past the end and below zero", () => {
  assert.equal(cmToHostOffset(CRLF, 99), CRLF.length);
  assert.equal(cmToHostOffset(CRLF, -5), 0);
  assert.equal(cmToHostOffset("", 3), 0);
});

test("cmToHostOffset: blank lines and Japanese text", () => {
  const text = "見出し\r\n\r\n日本語\r\n";
  assert.equal(cmToHostOffset(text, 3), 3);
  assert.equal(cmToHostOffset(text, 4), 5); // the empty line
  assert.equal(cmToHostOffset(text, 5), 7); // start of 日本語
  assert.equal(cmToHostOffset(text, 8), 10); // before the last break
  assert.equal(cmToHostOffset(text, 9), 12); // end
});

test("cmToHostOffset: LF text is the identity", () => {
  assert.equal(cmToHostOffset("a\nb\n", 2), 2);
  assert.equal(cmToHostOffset("a\nb\n", 4), 4);
});

test("cmToHostOffset: mixed endings only shift for CRLF", () => {
  assert.equal(cmToHostOffset("a\r\nb\nc", 4), 5);
});

test("hostToCmOffset: subtracts one per earlier line", () => {
  assert.equal(hostToCmOffset(0, 0), 0);
  assert.equal(hostToCmOffset(3, 1), 2); // start of "b" in CRLF
  assert.equal(hostToCmOffset(6, 2), 4); // end of document
});

test("round trip: host -> CodeMirror -> host over every offset", () => {
  const text = "# タイトル\r\n\r\n- a\r\n- bbb\r\n";
  for (let host = 0; host <= text.length; host++) {
    if (text[host] === "\n" && text[host - 1] === "\r") continue; // inside a CRLF
    const cm = hostToCmOffset(host, offsetToPosition(text, host).line);
    assert.equal(cmToHostOffset(text, cm), host, "host offset " + host);
  }
});

test("CodeMirror change lands in the right place of the CRLF document", () => {
  // The reported bug: typing at the end of "- bbb" (line 3) must not shift.
  const text = "# t\r\n\r\n- aaa\r\n- bbb\r\n- ccc\r\n";
  const state = EditorState.create({ doc: text });
  const cmEnd = state.doc.line(4).to; // end of "- bbb"
  const tr = state.update({ changes: { from: cmEnd, insert: "XYZ" } });
  const host = cmToHostOffset(text, cmEnd);
  assert.equal(text.slice(0, host).endsWith("- bbb"), true);
  const applied = text.slice(0, host) + "XYZ" + text.slice(host);
  assert.equal(applied, "# t\r\n\r\n- aaa\r\n- bbbXYZ\r\n- ccc\r\n");
  assert.equal(applied.replace(/\r\n/g, "\n"), tr.state.doc.toString());
});

test("CodeMirror normalises CRLF in text the host inserts", () => {
  const state = EditorState.create({ doc: "a\nb" });
  const next = state.update({ changes: { from: 1, insert: "\r\nx\r\n" } }).state;
  assert.equal(next.doc.toString(), "a\nx\n\nb");
});

// Simulate a VS Code content-change event (ranges and offsets all refer to the
// pre-change document, last edit first) and replay it onto a CodeMirror doc the
// way toDocChanges does.
test("host event with several changes maps through line numbers", () => {
  const pre = "aaa\r\nbbb\r\nccc\r\nddd\r\n";
  const edits = [
    { from: 0, to: 3, text: "A\r\nA2" }, // line 0, grows by a line
    { from: 10, to: 15, text: "" }, // line 2, "ccc" and its break
  ];
  const changes = [...edits].reverse().map((e) => ({
    from: hostToCmOffset(e.from, offsetToPosition(pre, e.from).line),
    to: hostToCmOffset(e.to, offsetToPosition(pre, e.to).line),
    insert: e.text,
  }));
  const cm = EditorState.create({ doc: pre }).update({ changes }).state.doc.toString();
  let host = pre;
  for (const e of [...edits].reverse()) {
    host = host.slice(0, e.from) + e.text + host.slice(e.to);
  }
  assert.equal(cm, host.replace(/\r\n/g, "\n"));
});

if (failed > 0) {
  console.error(`\n${failed} ranges test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll ranges tests passed");

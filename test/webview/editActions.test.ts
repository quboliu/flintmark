// L1 unit tests for the pure edit-action logic behind the formatting shortcuts,
// smart paste, and extended task detection (src/webview/view/editActions.ts).
// Pure string math → Node, no CM6/DOM. docs/05 top-of-pyramid.
import assert from "node:assert";
import {
  toggleInlineWrap,
  makeLinkEdit,
  linkPasteTransform,
  detectExtendedTask,
  URL_RE,
} from "../../src/webview/view/editActions";

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

// --- toggleInlineWrap --------------------------------------------------------

test("wrap: empty selection inserts the pair, caret between", () => {
  const e = toggleInlineWrap("ab", 1, 1, "**");
  assert.equal(e.insert, "****");
  assert.deepEqual([e.from, e.to], [1, 1]);
  assert.deepEqual([e.selFrom, e.selTo], [3, 3]);
});

test("wrap: selection becomes **sel**, inner re-selected", () => {
  const e = toggleInlineWrap("abc", 1, 2, "**"); // select "b"
  assert.equal(e.insert, "**b**");
  assert.deepEqual([e.selFrom, e.selTo], [3, 4]);
});

test("wrap: single-char marker (italic)", () => {
  assert.equal(toggleInlineWrap("x", 0, 1, "*").insert, "*x*");
});

test("unwrap: markers inside the selection", () => {
  const e = toggleInlineWrap("**b**", 0, 5, "**"); // select whole **b**
  assert.equal(e.insert, "b");
  assert.deepEqual([e.from, e.to], [0, 5]);
  assert.deepEqual([e.selFrom, e.selTo], [0, 1]);
});

test("unwrap: markers immediately outside the selection", () => {
  const e = toggleInlineWrap("**b**", 2, 3, "**"); // select just "b"
  assert.equal(e.insert, "b");
  assert.deepEqual([e.from, e.to], [0, 5]);
  assert.deepEqual([e.selFrom, e.selTo], [0, 1]);
});

test("wrap: code marker around a word", () => {
  const e = toggleInlineWrap("a foo b", 2, 5, "`"); // select "foo"
  assert.equal(e.insert, "`foo`");
});

test("italic on the INNER text of **bold** wraps, never strips a bold *", () => {
  // Regression: select "bold" inside **bold**, Mod-I must add italic → ***bold***
  // (not unwrap one * into *bold*).
  const e = toggleInlineWrap("**bold**", 2, 6, "*");
  assert.deepEqual([e.from, e.to], [2, 6]);
  assert.equal(e.insert, "*bold*"); // surrounding ** stays → ***bold***
});

test("italic on a whole **bold** selection does not strip it to *bold*", () => {
  const e = toggleInlineWrap("**bold**", 0, 8, "*");
  assert.notEqual(e.insert, "*bold*");
  assert.ok(e.insert.includes("**bold**"), "bold markers preserved");
});

test("bold still toggles OFF on **bold** (inner selection)", () => {
  const e = toggleInlineWrap("**bold**", 2, 6, "**");
  assert.deepEqual([e.from, e.to], [0, 8]);
  assert.equal(e.insert, "bold");
});

test("bold toggles OFF when the whole **bold** is selected", () => {
  const e = toggleInlineWrap("**bold**", 0, 8, "**");
  assert.equal(e.insert, "bold");
});

test("inline code unwraps a lone `code`", () => {
  const e = toggleInlineWrap("`x`", 0, 3, "`");
  assert.equal(e.insert, "x");
});

// --- makeLinkEdit ------------------------------------------------------------

test("link: wraps selection, caret inside ()", () => {
  const e = makeLinkEdit("abc", 0, 3);
  assert.equal(e.insert, "[abc]()");
  assert.deepEqual([e.selFrom, e.selTo], [6, 6]); // after "[abc]("
});

test("link: empty selection, caret inside []", () => {
  const e = makeLinkEdit("x", 1, 1);
  assert.equal(e.insert, "[]()");
  assert.deepEqual([e.selFrom, e.selTo], [2, 2]);
});

// --- linkPasteTransform ------------------------------------------------------

test("paste: URL over a selection → markdown link", () => {
  assert.equal(linkPasteTransform("text", "https://x.com"), "[text](https://x.com)");
});

test("paste: clipboard URL is trimmed", () => {
  assert.equal(linkPasteTransform("t", "  https://x.com  "), "[t](https://x.com)");
});

test("paste: mailto URL works", () => {
  assert.equal(linkPasteTransform("mail", "mailto:a@b.com"), "[mail](mailto:a@b.com)");
});

test("paste: empty selection → null (default paste)", () => {
  assert.equal(linkPasteTransform("", "https://x.com"), null);
});

test("paste: non-URL clipboard → null", () => {
  assert.equal(linkPasteTransform("t", "hello world"), null);
  assert.equal(linkPasteTransform("t", "just text"), null);
});

test("paste: URL followed by text (has whitespace) → null", () => {
  assert.equal(linkPasteTransform("t", "https://x.com and more"), null);
});

// --- detectExtendedTask ------------------------------------------------------

test("ext task: [/] in-progress after the list mark", () => {
  assert.deepEqual(detectExtendedTask("- [/] todo", 1), { from: 2, to: 5, char: "/" });
});

test("ext task: [-] cancelled", () => {
  assert.deepEqual(detectExtendedTask("- [-] x", 1), { from: 2, to: 5, char: "-" });
});

test("ext task: at end of line (no trailing text)", () => {
  assert.deepEqual(detectExtendedTask("- [?]", 1), { from: 2, to: 5, char: "?" });
});

test("ext task: space / x / X are GFM → null", () => {
  assert.equal(detectExtendedTask("- [ ] a", 1), null);
  assert.equal(detectExtendedTask("- [x] a", 1), null);
  assert.equal(detectExtendedTask("- [X] a", 1), null);
});

test("ext task: a real link [a](url) is NOT a task", () => {
  assert.equal(detectExtendedTask("- [a](u) x", 1), null);
});

test("ext task: multi-char bracket is not a marker", () => {
  assert.equal(detectExtendedTask("- [ab] x", 1), null);
});

test("ext task: no bracket → null", () => {
  assert.equal(detectExtendedTask("- plain text", 1), null);
});

// --- URL_RE ------------------------------------------------------------------

test("URL_RE: accepts http/https/mailto, rejects ftp + whitespace", () => {
  assert.ok(URL_RE.test("https://a.b/c"));
  assert.ok(URL_RE.test("http://a"));
  assert.ok(URL_RE.test("mailto:a@b.com"));
  assert.ok(!URL_RE.test("ftp://a"));
  assert.ok(!URL_RE.test("has space"));
});

if (failed > 0) {
  console.error(`\n${failed} editActions test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll editActions tests passed");

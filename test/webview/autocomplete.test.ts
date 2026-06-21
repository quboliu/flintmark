// L1 unit tests for the autocomplete decision logic (analyzeCompletion) and
// heading extraction (docHeadings) — src/webview/view/autocomplete.ts. Pure, no
// CM6/DOM. docs/05 top-of-pyramid.
import assert from "node:assert";
import { analyzeCompletion, docHeadings } from "../../src/webview/view/autocomplete";

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

// --- analyzeCompletion: wikilink ---------------------------------------------

test("wikilink: [[Fo → kind wikilink, query Fo, close ]]", () => {
  assert.deepEqual(analyzeCompletion("[[Fo", ""), {
    kind: "wikilink",
    query: "Fo",
    from: 2,
    close: "]]",
  });
});

test("wikilink: mid-line offset is correct", () => {
  const r = analyzeCompletion("see [[Fo", " x");
  assert.equal(r?.kind, "wikilink");
  assert.equal(r?.from, 6);
});

test("wikilink: existing ]] after cursor → no extra close", () => {
  assert.equal(analyzeCompletion("[[Fo", "]]")?.close, "");
});

// --- analyzeCompletion: headings ---------------------------------------------

test("heading: [[#sec → kind heading, query sec", () => {
  assert.deepEqual(analyzeCompletion("[[#sec", ""), {
    kind: "heading",
    query: "sec",
    from: 3,
    close: "]]",
  });
});

test("cross-note [[Note#sec is out of scope → null", () => {
  assert.equal(analyzeCompletion("[[Note#sec", ""), null);
});

// --- analyzeCompletion: tags -------------------------------------------------

test("tag: #ta at line start", () => {
  assert.deepEqual(analyzeCompletion("#ta", ""), { kind: "tag", query: "ta", from: 1, close: "" });
});

test("tag: after a space", () => {
  const r = analyzeCompletion("a #ta", "");
  assert.equal(r?.kind, "tag");
  assert.equal(r?.from, 3);
});

test("tag: C# (preceded by word) is not a tag", () => {
  assert.equal(analyzeCompletion("C#", ""), null);
  assert.equal(analyzeCompletion("C#m", ""), null);
});

test("heading line '# ' / '## H' does not trigger the tag list", () => {
  assert.equal(analyzeCompletion("# ", ""), null);
  assert.equal(analyzeCompletion("## H", ""), null);
});

test("bare '#' (possible heading) does not trigger tags", () => {
  assert.equal(analyzeCompletion("#", ""), null);
});

test("plain text → null", () => {
  assert.equal(analyzeCompletion("just typing", ""), null);
});

// --- docHeadings -------------------------------------------------------------

test("docHeadings: extracts titles in order", () => {
  assert.deepEqual(docHeadings("# A\n\nbody\n## B\n### C"), ["A", "B", "C"]);
});

test("docHeadings: ignores # inside fenced code", () => {
  assert.deepEqual(docHeadings("# A\n```\n# not a heading\n```\n## B"), ["A", "B"]);
});

test("docHeadings: strips trailing # and dedupes", () => {
  assert.deepEqual(docHeadings("# A #\n\n# A"), ["A"]);
});

test("docHeadings: none → empty", () => {
  assert.deepEqual(docHeadings("no headings here\njust text"), []);
});

test("docHeadings: includes Setext headings (=== / ---)", () => {
  assert.deepEqual(
    docHeadings("Title One\n===\n\nbody\n\nSub Two\n---\n"),
    ["Title One", "Sub Two"]
  );
});

test("docHeadings: an underline with no text line above is not a heading", () => {
  assert.deepEqual(docHeadings("\n---\n"), []);
});

if (failed > 0) {
  console.error(`\n${failed} autocomplete test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll autocomplete tests passed");

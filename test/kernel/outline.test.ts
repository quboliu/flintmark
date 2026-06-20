// Pure-logic test for the heading-outline parser (no vscode). Runs in Node via
// test/run-unit.mjs.
import assert from "node:assert";
import { parseHeadings } from "../../src/extension/outlineParser";

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

test("extracts ATX headings with levels and line numbers", () => {
  const heads = parseHeadings("# A\n\ntext\n\n## B\n\n### C\n");
  assert.deepEqual(
    heads.map((h) => [h.level, h.text, h.line]),
    [
      [1, "A", 0],
      [2, "B", 4],
      [3, "C", 6],
    ]
  );
});

test("ignores '#' inside fenced code blocks", () => {
  const heads = parseHeadings("# Real\n\n```\n# not a heading\n```\n\n## Also Real\n");
  assert.deepEqual(
    heads.map((h) => h.text),
    ["Real", "Also Real"]
  );
});

test("skips a leading YAML frontmatter block", () => {
  const heads = parseHeadings("---\ntitle: X\ntags: [a]\n---\n\n# Heading\n");
  assert.deepEqual(
    heads.map((h) => [h.level, h.text]),
    [[1, "Heading"]]
  );
});

test("parses setext headings (=== -> h1, --- -> h2)", () => {
  const heads = parseHeadings("Title One\n=========\n\nTitle Two\n---------\n");
  assert.deepEqual(
    heads.map((h) => [h.level, h.text]),
    [
      [1, "Title One"],
      [2, "Title Two"],
    ]
  );
});

test("does not treat a list item / HR as a setext heading", () => {
  // Blank line before `---` => thematic break, not setext.
  const heads = parseHeadings("para\n\n---\n\n- item\n");
  assert.equal(heads.length, 0, `expected no headings, got ${JSON.stringify(heads)}`);
});

test("strips trailing closing hashes from ATX text", () => {
  const heads = parseHeadings("## Heading ##\n");
  assert.deepEqual(heads.map((h) => h.text), ["Heading"]);
});

// --- edge cases that pin the exact parsing rules (mutation-hardening) --------

test("a '#' that is not at the line start is not a heading", () => {
  // The parser requires `^#`; a mid-line hash must not become a heading.
  assert.equal(parseHeadings("prose # not a heading\n").length, 0);
});

test("trailing closing hashes are stripped regardless of count", () => {
  assert.deepEqual(parseHeadings("# Title ###\n").map((h) => h.text), ["Title"]);
  assert.deepEqual(parseHeadings("### Mid #\n").map((h) => h.text), ["Mid"]);
});

test("an ATX heading with empty text becomes (untitled)", () => {
  // `# ` (hash + space, no text) → "(untitled)"; bare `#` (no space) is not ATX.
  assert.deepEqual(parseHeadings("# \n").map((h) => [h.level, h.text]), [[1, "(untitled)"]]);
  assert.equal(parseHeadings("#\n").length, 0);
});

test("a single backtick does not open a code fence (needs 3+)", () => {
  // If one backtick wrongly started a fence, the following heading would vanish.
  assert.deepEqual(parseHeadings("`inline`\n# After\n").map((h) => h.text), ["After"]);
});

test("a fence only closes on a MATCHING fence char", () => {
  // ``` opens; ~~~ must NOT close it; the real ``` does → only "visible" parses.
  const h = parseHeadings("```\n# hidden1\n~~~\n# hidden2\n```\n# visible\n");
  assert.deepEqual(h.map((x) => x.text), ["visible"]);
});

test("list / quote / ordered lines are never setext heading text", () => {
  for (const lead of ["- item", "* item", "+ item", "1. item", "2) item", "> quote"]) {
    assert.equal(
      parseHeadings(lead + "\n---\n").length,
      0,
      `"${lead}" over --- must not be a heading`
    );
  }
});

test("a setext underline must span the WHOLE line", () => {
  assert.equal(parseHeadings("Title\n=== not pure\n").length, 0); // text after === → not an underline
  assert.deepEqual(parseHeadings("Title\n===\n").map((h) => [h.level, h.text]), [[1, "Title"]]);
});

test("frontmatter is only at line 0 and is closed by --- or ...", () => {
  assert.deepEqual(parseHeadings("---\nk: v\n...\n# H\n").map((h) => h.text), ["H"]); // ... closes
  // A later --- is NOT frontmatter — both ATX headings must survive.
  assert.deepEqual(
    parseHeadings("# First\n---\n# Second\n").map((h) => h.text),
    ["First", "Second"]
  );
});

test("a paragraph on the final line (no underline) is not a heading", () => {
  assert.equal(parseHeadings("just a trailing paragraph").length, 0);
});

test("fence markers must be at the line start (not mid-line)", () => {
  // mid-line ``` must NOT open a fence → the following heading still parses.
  assert.deepEqual(parseHeadings("text ```more\n# H\n").map((x) => x.text), ["H"]);
});

test("a single tilde does not open a code fence (needs 3+)", () => {
  assert.deepEqual(parseHeadings("~\n# H\n").map((x) => x.text), ["H"]);
});

test("a setext underline must start at column 0 (no leading junk)", () => {
  assert.equal(parseHeadings("Para\nx===\n").length, 0); // 'x===' is not an underline
  assert.equal(parseHeadings("Para\nx---\n").length, 0);
});

if (failed > 0) {
  console.error(`\n${failed} outline test(s) FAILED`);
  process.exit(1);
}
console.log("outline tests passed");

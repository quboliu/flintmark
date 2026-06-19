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

if (failed > 0) {
  console.error(`\n${failed} outline test(s) FAILED`);
  process.exit(1);
}
console.log("outline tests passed");

// Pure-logic test for the tolerant GFM-table detector (runs in Node via
// test/run-unit.mjs). Guards the real bug: a delimiter row with a trailing
// space made @lezer/markdown drop the table; our detector must accept it.
import assert from "node:assert";
import {
  isTableDelimiter,
  findTableBlocks,
  findComments,
  findFootnotes,
} from "../../src/webview/view/markdownDecorations";

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

test("isTableDelimiter accepts standard / trailing-space / aligned rows", () => {
  assert.ok(isTableDelimiter("| --- | --- |"));
  assert.ok(isTableDelimiter("|---|---| "), "trailing space (the real bug)");
  assert.ok(isTableDelimiter("| :--- | :---: | ---: |"), "alignment colons");
  assert.ok(isTableDelimiter("--- | ---"), "borderless");
  assert.ok(isTableDelimiter("|-----------------|--------------------|---------| "));
});

test("isTableDelimiter rejects non-delimiters", () => {
  assert.ok(!isTableDelimiter("| a | b |"), "no dashes");
  assert.ok(!isTableDelimiter("just some text"));
  assert.ok(!isTableDelimiter("- a bullet"));
});

test("findTableBlocks detects a table whose delimiter has a trailing space", () => {
  const text = "intro\n\n| # | A | B |\n|---|---|---| \n| 1 | x | y |\n\nafter\n";
  const blocks = findTableBlocks(text);
  assert.equal(blocks.length, 1, "one table detected");
  // block spans from the header to the end of the last data row
  assert.equal(text.slice(blocks[0].from, blocks[0].to).split("\n").length, 3);
  assert.ok(text.slice(blocks[0].from).startsWith("| # | A | B |"));
});

test("findTableBlocks ignores a table inside a fenced code block", () => {
  const text = "```\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```\n";
  assert.equal(findTableBlocks(text).length, 0);
});

test("findTableBlocks finds multiple tables", () => {
  const text =
    "| A | B |\n| --- | --- |\n| 1 | 2 |\n\nmid\n\n| C | D |\n| --- | --- |\n| 3 | 4 |\n";
  assert.equal(findTableBlocks(text).length, 2);
});

test("findTableBlocks: a lone pipe line is not a table", () => {
  assert.equal(findTableBlocks("a | b sentence\n\nmore text\n").length, 0);
});

test("findComments detects an inline %%...%% span", () => {
  const text = "a %%c%% b\n";
  const r = findComments(text);
  assert.equal(r.length, 1);
  assert.equal(text.slice(r[0].from, r[0].to), "%%c%%");
});

test("findComments detects a multi-line block comment", () => {
  const text = "x\n%%\nhidden\n%%\ny\n";
  const r = findComments(text);
  assert.equal(r.length, 1);
  assert.ok(text.slice(r[0].from).startsWith("%%\nhidden\n%%"));
});

test("findComments ignores %% inside a fenced code block (mermaid)", () => {
  const text = "```mermaid\ngraph TD\n%% a mermaid comment\nA-->B\n```\n";
  assert.equal(findComments(text).length, 0);
});

test("findComments ignores an unpaired %%", () => {
  assert.equal(findComments("just %% one marker here\n").length, 0);
});

test("findFootnotes detects an inline reference [^1]", () => {
  const text = "Brotli [^1] is fast.\n";
  const r = findFootnotes(text);
  assert.equal(r.length, 1);
  assert.equal(text.slice(r[0].from, r[0].to), "[^1]");
  assert.equal(text.slice(r[0].idFrom, r[0].idTo), "1");
});

test("findFootnotes detects a definition [^1]: and doesn't double-count it as a ref", () => {
  const text = "body [^note] here.\n\n[^note]: the definition\n";
  const r = findFootnotes(text);
  assert.equal(r.length, 2, "one ref + one def");
  const def = r.find((x) => text.slice(x.from, x.to) === "[^note]:");
  assert.ok(def, "definition marker spans `[^note]:`");
  assert.equal(text.slice(def.idFrom, def.idTo), "note");
});

test("findFootnotes ignores [^x] inside fenced code", () => {
  const text = "```\narr[^1] = 2\n```\n";
  assert.equal(findFootnotes(text).length, 0);
});

if (failed > 0) {
  console.error(`\n${failed} tableDetect test(s) FAILED`);
  process.exit(1);
}
console.log("tableDetect tests passed");

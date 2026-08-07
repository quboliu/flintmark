import assert from "node:assert";
import { parseDocumentStructure } from "../../src/extension/documentStructureParser";

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

test("extracts standard and extended task states in source order", () => {
  const structure = parseDocumentStructure(
    "# Plan\n\n- [ ] open\n- [x] done\n- [X] DONE\n- [/] active\n- [-] cancelled\n"
  );
  assert.deepEqual(
    structure.todos.map((todo) => [todo.status, todo.text, todo.line, todo.character]),
    [
      [" ", "open", 2, 2],
      ["x", "done", 3, 2],
      ["X", "DONE", 4, 2],
      ["/", "active", 5, 2],
      ["-", "cancelled", 6, 2],
    ]
  );
  assert.deepEqual(structure.headings.map((heading) => heading.text), ["Plan"]);
});

test("supports ordered, nested, blockquoted, and empty tasks", () => {
  const structure = parseDocumentStructure(
    "1. [ ] ordered\n   - [?] nested\n> - [>] quoted\n- [ ]\n"
  );
  assert.deepEqual(
    structure.todos.map((todo) => [todo.status, todo.text, todo.line]),
    [
      [" ", "ordered", 0],
      ["?", "nested", 1],
      [">", "quoted", 2],
      [" ", "", 3],
    ]
  );
});

test("ignores task-like text outside real Markdown list items", () => {
  const structure = parseDocumentStructure(
    "---\nitems:\n  - [ ] frontmatter\n---\n\n" +
      "```md\n- [ ] fenced\n```\n\n" +
      "    - [ ] indented code\n\n" +
      "plain [ ] text\n[a](url)\n- [a](url)\n- [ ] real\n"
  );
  assert.deepEqual(structure.todos.map((todo) => todo.text), ["real"]);
});

test("does not leak tasks out of a fenced blockquote", () => {
  const structure = parseDocumentStructure(
    "> ```\n> - [ ] fenced\n> ```\n> - [ ] real\n"
  );
  assert.deepEqual(structure.todos.map((todo) => todo.text), ["real"]);
});

test("preserves duplicate tasks and exact CRLF positions", () => {
  const structure = parseDocumentStructure("- [ ] same\r\n  - [ ] same\r\n");
  assert.equal(structure.todos.length, 2);
  assert.deepEqual(
    structure.todos.map((todo) => [todo.line, todo.character, todo.markerFrom, todo.markerTo]),
    [
      [0, 2, 2, 5],
      [1, 4, 16, 19],
    ]
  );
});

test("requires whitespace after a task marker", () => {
  const structure = parseDocumentStructure("- [ ]valid-looking-but-invalid\n- [ ] valid\n");
  assert.deepEqual(structure.todos.map((todo) => todo.text), ["valid"]);
});

test("accepts every Markdown list-marker form and tab spacing", () => {
  const structure = parseDocumentStructure(
    "*\t[ ] star-tab\n+ [x] plus\n1) [?] ordered-paren\n2.\t[>] ordered-tab\n"
  );
  assert.deepEqual(
    structure.todos.map((todo) => [todo.status, todo.text]),
    [
      [" ", "star-tab"],
      ["x", "plus"],
      ["?", "ordered-paren"],
      [">", "ordered-tab"],
    ]
  );
});

test("handles Unicode, no final newline, and first-line-only task labels", () => {
  const structure = parseDocumentStructure(
    "- [ ] 中文任务 🚀\n  continuation text\n- [/] آخر مهمة"
  );
  assert.deepEqual(
    structure.todos.map((todo) => [todo.status, todo.text, todo.line]),
    [
      [" ", "中文任务 🚀", 0],
      ["/", "آخر مهمة", 2],
    ]
  );
});

test("rejects escaped, malformed, multi-character, and HTML-block lookalikes", () => {
  const structure = parseDocumentStructure(
    "\\- [ ] escaped\n-[ ] no-space-after-list-mark\n- [xx] two-chars\n" +
      "<div>\n- [ ] inside-html\n</div>\n\n- [ ] real"
  );
  assert.deepEqual(structure.todos.map((todo) => todo.text), ["real"]);
});

test("an unclosed fence keeps all following task lookalikes out", () => {
  const structure = parseDocumentStructure("~~~md\n- [ ] still fenced\n- [?] also fenced");
  assert.deepEqual(structure.todos, []);
});

test("frontmatter is recognized only at the start and with a valid closing delimiter", () => {
  const laterDelimiter = parseDocumentStructure(
    "intro\n---\n- [ ] after thematic break\n---\n- [ ] final\n"
  );
  assert.deepEqual(laterDelimiter.todos.map((todo) => todo.text), [
    "after thematic break",
    "final",
  ]);

  const invalidClose = parseDocumentStructure(
    "---\n# visible because close is invalid\n---oops\n- [ ] must not be masked forever\n"
  );
  assert.deepEqual(invalidClose.todos.map((todo) => todo.text), ["must not be masked forever"]);
  assert.deepEqual(invalidClose.headings.map((heading) => heading.text), [
    "visible because close is invalid",
  ]);

  const closeAtEof = parseDocumentStructure("---\n# hidden metadata heading\n- [ ] hidden metadata task\n...");
  assert.deepEqual(closeAtEof, { headings: [], todos: [] });
});

test("normalizes heading labels without accepting a bare hash", () => {
  const structure = parseDocumentStructure(
    "#\n# \n##   Spaced heading   ##   \n\n  Setext label  \r\n---\r\n"
  );
  assert.deepEqual(
    structure.headings.map((heading) => [heading.level, heading.text, heading.line]),
    [
      [1, "(untitled)", 1],
      [2, "Spaced heading", 2],
      [2, "Setext label", 4],
    ]
  );
});

test("accepts horizontal whitespace around task text and strips only the line ending", () => {
  const structure = parseDocumentStructure("-\t[ ]\t\tlabel with spaces   \r\n- [x]\t\r\n");
  assert.deepEqual(
    structure.todos.map((todo) => [todo.status, todo.text, todo.line, todo.character]),
    [
      [" ", "label with spaces", 0, 2],
      ["x", "", 1, 2],
    ]
  );
});

test("rejects incomplete checkbox markers at end of line", () => {
  const structure = parseDocumentStructure("- [\n- []\n- []] invalid-middle\n- [ ] valid\n");
  assert.deepEqual(structure.todos.map((todo) => todo.text), ["valid"]);
});

test("accepts an empty task ending directly before a CRLF", () => {
  const structure = parseDocumentStructure("- [x]\r\n");
  assert.deepEqual(
    structure.todos.map((todo) => [todo.status, todo.text, todo.markerFrom, todo.markerTo]),
    [["x", "", 2, 5]]
  );
});

if (failed > 0) {
  console.error(`\n${failed} document structure test(s) FAILED`);
  process.exit(1);
}
console.log("document structure tests passed");

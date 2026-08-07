import assert from "node:assert";
import { DocumentStructureCache } from "../../src/extension/documentStructureCache";
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

test("scans a URI/document version at most once for all consumers", () => {
  let scans = 0;
  const cache = new DocumentStructureCache((text) => {
    scans++;
    return parseDocumentStructure(text);
  });

  const outlineRead = cache.get("file:///note.md", 7, "# H\n- [ ] task\n");
  const todoRead = cache.get("file:///note.md", 7, "ignored duplicate read");
  assert.strictEqual(todoRead, outlineRead);
  assert.equal(scans, 1);
  assert.deepEqual(outlineRead.headings.map((heading) => heading.text), ["H"]);
  assert.deepEqual(todoRead.todos.map((todo) => todo.text), ["task"]);

  cache.get("file:///note.md", 8, "# H2\n- [x] done\n");
  assert.equal(scans, 2, "a new TextDocument version must produce one new scan");

  cache.get("file:///other.md", 1, "- [ ] other\n");
  assert.equal(scans, 3, "documents have independent version caches");
});

test("delete prevents a reopened document from reusing a stale snapshot", () => {
  let scans = 0;
  const cache = new DocumentStructureCache((text) => {
    scans++;
    return parseDocumentStructure(text);
  });
  cache.get("file:///note.md", 1, "- [ ] old\n");
  cache.delete("file:///note.md");
  const reopened = cache.get("file:///note.md", 1, "- [ ] new\n");
  assert.equal(scans, 2);
  assert.deepEqual(reopened.todos.map((todo) => todo.text), ["new"]);
});

test("peek is read-only and clear invalidates every document snapshot", () => {
  let scans = 0;
  const cache = new DocumentStructureCache((text) => {
    scans++;
    return parseDocumentStructure(text);
  });
  assert.equal(cache.peek("file:///missing.md"), undefined);

  const first = cache.get("file:///first.md", 1, "- [ ] first\n");
  cache.get("file:///second.md", 1, "- [ ] second\n");
  assert.strictEqual(cache.peek("file:///first.md"), first);
  assert.equal(scans, 2, "peek must not parse");

  cache.clear();
  assert.equal(cache.peek("file:///first.md"), undefined);
  assert.equal(cache.peek("file:///second.md"), undefined);
  cache.get("file:///first.md", 1, "- [ ] fresh\n");
  assert.equal(scans, 3, "clear must force a fresh parse even at the same version");
});

if (failed > 0) {
  console.error(`\n${failed} document structure cache test(s) FAILED`);
  process.exit(1);
}
console.log("document structure cache tests passed");

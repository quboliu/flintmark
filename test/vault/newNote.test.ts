// L1 unit tests for resolveNewNoteName (src/extension/vault/newNote.ts) — the
// pure target→filename logic behind "create note on clicking an unresolved
// [[wikilink]]". Pure, host-side, no vscode. docs/05 top-of-pyramid.
import assert from "node:assert";
import { resolveNewNoteName } from "../../src/extension/vault/newNote";

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

test("plain name → <name>.md", () => {
  assert.equal(resolveNewNoteName("Foo"), "Foo.md");
});

test("spaces in the name are preserved", () => {
  assert.equal(resolveNewNoteName("My Great Note"), "My Great Note.md");
});

test("alias (|…) is stripped", () => {
  assert.equal(resolveNewNoteName("Foo|Bar"), "Foo.md");
});

test("heading/block anchor (#…) is stripped", () => {
  assert.equal(resolveNewNoteName("Foo#Section"), "Foo.md");
  assert.equal(resolveNewNoteName("Foo#Section|Alias"), "Foo.md");
});

test("a typed .md/.markdown extension is normalized", () => {
  assert.equal(resolveNewNoteName("Foo.md"), "Foo.md");
  assert.equal(resolveNewNoteName("Foo.markdown"), "Foo.md");
});

test("subpath → basename only (never creates directories)", () => {
  assert.equal(resolveNewNoteName("a/b/Foo"), "Foo.md");
  assert.equal(resolveNewNoteName("a\\b\\Foo"), "Foo.md");
});

test("traversal collapses to a safe basename (stays in the folder)", () => {
  // "../secret" → basename "secret"; bare ".."/"." reject.
  assert.equal(resolveNewNoteName("../secret"), "secret.md");
  assert.equal(resolveNewNoteName(".."), null);
  assert.equal(resolveNewNoteName("."), null);
});

test("empty / whitespace → null", () => {
  assert.equal(resolveNewNoteName(""), null);
  assert.equal(resolveNewNoteName("   "), null);
});

test("filename-illegal characters → null", () => {
  for (const t of ['a:b', 'a"b', "a?b", "a*b", "a<b", "a>b"]) {
    assert.equal(resolveNewNoteName(t), null, `expected null for ${JSON.stringify(t)}`);
  }
});

test("non-string input → null", () => {
  assert.equal(resolveNewNoteName(undefined as unknown as string), null);
  assert.equal(resolveNewNoteName(123 as unknown as string), null);
});

if (failed > 0) {
  console.error(`\n${failed} newNote test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll newNote tests passed");

// Pure-logic tests for the Vault Index core (no VS Code).
import assert from "node:assert";
import { buildVaultIndex } from "../../src/extension/vault/vaultIndex";

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

// --------------------------------------------------------------------------
// Notes, names, tags
// --------------------------------------------------------------------------

test("getAllNotes derives names without directory/extension, sorted by path", () => {
  const idx = buildVaultIndex([
    { path: "b/Beta.md", text: "" },
    { path: "a/Alpha.md", text: "" },
  ]);
  assert.deepEqual(
    idx.getAllNotes().map((n) => [n.path, n.name]),
    [
      ["a/Alpha.md", "Alpha"],
      ["b/Beta.md", "Beta"],
    ]
  );
});

test("tags are de-duplicated case-insensitively on a note", () => {
  const idx = buildVaultIndex([{ path: "T.md", text: "#dup #dup #DUP" }]);
  assert.deepEqual(idx.getNote("T.md")?.tags, ["dup"]);
});

test("getTagged is case-insensitive and accepts a leading '#'", () => {
  const idx = buildVaultIndex([
    { path: "T1.md", text: "#Project #todo" },
    { path: "T2.md", text: "#project" },
  ]);
  assert.deepEqual(idx.getTagged("project"), ["T1.md", "T2.md"]);
  assert.deepEqual(idx.getTagged("#PROJECT"), ["T1.md", "T2.md"]);
  assert.deepEqual(idx.getTagged("todo"), ["T1.md"]);
  assert.deepEqual(idx.getTagged("missing"), []);
});

test("getAllTags returns lowercased, sorted, unique tags", () => {
  const idx = buildVaultIndex([
    { path: "T1.md", text: "#todo #Project" },
    { path: "T2.md", text: "#dup #dup" },
  ]);
  assert.deepEqual(idx.getAllTags(), ["dup", "project", "todo"]);
});

// --------------------------------------------------------------------------
// Link graph: outgoing / backlinks / unresolved
// --------------------------------------------------------------------------

test("backlinks are the reverse of outgoing links", () => {
  const idx = buildVaultIndex([
    { path: "A.md", text: "[[B]] and [[C]]" },
    { path: "B.md", text: "[[A]]" },
    { path: "C.md", text: "no links" },
  ]);
  assert.deepEqual(idx.getOutgoingLinks("A.md"), ["B.md", "C.md"]);
  assert.deepEqual(idx.getBacklinks("A.md"), ["B.md"]);
  assert.deepEqual(idx.getBacklinks("B.md"), ["A.md"]);
  assert.deepEqual(idx.getBacklinks("C.md"), ["A.md"]);
  assert.deepEqual(idx.getBacklinks("B.md").length, 1);
});

test("a target with no matching note is reported as unresolved, not a backlink", () => {
  const idx = buildVaultIndex([{ path: "A.md", text: "[[Ghost]] [[A]]" }]);
  assert.deepEqual(idx.getUnresolvedLinks("A.md"), ["Ghost"]);
  assert.deepEqual(idx.getOutgoingLinks("A.md"), ["A.md"]);
});

test("same-note heading link [[#H]] creates no edge", () => {
  const idx = buildVaultIndex([{ path: "S.md", text: "[[#Heading]]" }]);
  assert.deepEqual(idx.getOutgoingLinks("S.md"), []);
  assert.deepEqual(idx.getUnresolvedLinks("S.md"), []);
});

test("an aliased/subpath link still resolves by its bare target", () => {
  const idx = buildVaultIndex([
    { path: "A.md", text: "[[B#Section|see B]]" },
    { path: "B.md", text: "" },
  ]);
  assert.deepEqual(idx.getOutgoingLinks("A.md"), ["B.md"]);
  assert.deepEqual(idx.getBacklinks("B.md"), ["A.md"]);
});

// --------------------------------------------------------------------------
// resolveLink
// --------------------------------------------------------------------------

test("resolveLink: hit and miss", () => {
  const idx = buildVaultIndex([{ path: "notes/Foo.md", text: "" }]);
  assert.equal(idx.resolveLink("Foo"), "notes/Foo.md");
  assert.equal(idx.resolveLink("Nope"), null);
  assert.equal(idx.resolveLink(""), null);
});

test("resolveLink is case-insensitive on the basename", () => {
  const idx = buildVaultIndex([{ path: "Foo.md", text: "" }]);
  assert.equal(idx.resolveLink("foo"), "Foo.md");
  assert.equal(idx.resolveLink("FOO"), "Foo.md");
});

test("resolveLink ignores an explicit .md extension on the target", () => {
  const idx = buildVaultIndex([{ path: "Foo.md", text: "" }]);
  assert.equal(idx.resolveLink("Foo.md"), "Foo.md");
});

test("resolveLink: ambiguous → deterministic shortest/lexicographic path", () => {
  const idx = buildVaultIndex([
    { path: "b/Note.md", text: "" },
    { path: "a/Note.md", text: "" },
  ]);
  assert.equal(idx.resolveLink("Note"), "a/Note.md");
});

test("resolveLink: a path hint disambiguates", () => {
  const idx = buildVaultIndex([
    { path: "a/Note.md", text: "" },
    { path: "b/Note.md", text: "" },
  ]);
  assert.equal(idx.resolveLink("b/Note"), "b/Note.md");
});

test("resolveLink: exact-case basename beats a case-only match", () => {
  const idx = buildVaultIndex([
    { path: "x/note.md", text: "" },
    { path: "y/Note.md", text: "" },
  ]);
  assert.equal(idx.resolveLink("Note"), "y/Note.md");
});

test("resolveLink: backslash separators compare equal to forward slash", () => {
  const idx = buildVaultIndex([{ path: "C:\\vault\\Foo.md", text: "" }]);
  assert.equal(idx.resolveLink("Foo"), "C:\\vault\\Foo.md");
  assert.equal(idx.resolveLink("vault/Foo"), "C:\\vault\\Foo.md");
});

// --------------------------------------------------------------------------
// Path normalization + scoring edges (mutation-hardening)
// --------------------------------------------------------------------------

test("the .md/.markdown extension is stripped case-insensitively", () => {
  const idx = buildVaultIndex([
    { path: "Foo.MD", text: "" },
    { path: "Bar.MARKDOWN", text: "" },
  ]);
  assert.equal(idx.getNote("Foo.MD")?.name, "Foo");
  assert.equal(idx.resolveLink("Foo"), "Foo.MD");
  assert.equal(idx.resolveLink("Bar"), "Bar.MARKDOWN");
});

test("path normalization drops empty segments; name is the last segment", () => {
  const idx = buildVaultIndex([{ path: "a//Foo.md", text: "" }]);
  assert.equal(idx.getNote("a//Foo.md")?.name, "Foo");
  assert.equal(idx.resolveLink("Foo"), "a//Foo.md");
});

test("resolveLink: a name that is only separators/whitespace is null", () => {
  const idx = buildVaultIndex([{ path: "Foo.md", text: "" }]);
  assert.equal(idx.resolveLink("/"), null);
  assert.equal(idx.resolveLink("   "), null);
});

test("resolveLink: an exact-case path hint outranks a case-only path hint", () => {
  const idx = buildVaultIndex([
    { path: "Sub/Note.md", text: "" }, // exact-case path-hint match  (+8)
    { path: "sub/Note.md", text: "" }, // case-only path-hint match    (+6)
  ]);
  assert.equal(idx.resolveLink("Sub/Note"), "Sub/Note.md");
});

test("resolveLink: with equal scores, the SHORTER path wins", () => {
  const idx = buildVaultIndex([
    { path: "deep/folder/Note.md", text: "" }, // 3 segments
    { path: "Note.md", text: "" }, //             1 segment
  ]);
  assert.equal(idx.resolveLink("Note"), "Note.md");
});

test("resolveLink trims surrounding whitespace on the name", () => {
  const idx = buildVaultIndex([{ path: "notes/Foo.md", text: "" }]);
  assert.equal(idx.resolveLink("  Foo  "), "notes/Foo.md");
});

test("resolveLink: a path hint scores above a bare-basename match", () => {
  // "z/Note" path-hint matches z/Note.md (+8); Note.md only matches the basename.
  // Without path-hint scoring the SHORTER Note.md would wrongly win.
  const idx = buildVaultIndex([
    { path: "z/Note.md", text: "" },
    { path: "Note.md", text: "" },
  ]);
  assert.equal(idx.resolveLink("z/Note"), "z/Note.md");
});

test("resolveLink tiebreak prefers the shorter path even when it sorts later", () => {
  // "Note.md" (1 seg, sorts AFTER "A/..") must still win on length, not lexicography.
  const idx = buildVaultIndex([
    { path: "A/Note.md", text: "" },
    { path: "Note.md", text: "" },
  ]);
  assert.equal(idx.resolveLink("Note"), "Note.md");
});

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll vaultIndex tests passed");

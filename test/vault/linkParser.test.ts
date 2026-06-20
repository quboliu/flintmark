// Pure-logic tests for the Vault Index link/tag extractor (no VS Code).
// Same lightweight style as test/sync/documentSync.test.ts.
import assert from "node:assert";
import {
  parseNote,
  extractWikiLinks,
  extractTags,
} from "../../src/extension/vault/linkParser";

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

const targets = (text: string): string[] =>
  extractWikiLinks(text).map((l) => l.target);
const tagNames = (text: string): string[] =>
  extractTags(text).map((t) => t.tag);

// --------------------------------------------------------------------------
// Wikilinks
// --------------------------------------------------------------------------

test("plain wikilink", () => {
  assert.deepEqual(targets("see [[Foo]] here"), ["Foo"]);
});

test("wikilink with alias strips the alias from the target", () => {
  const [l] = extractWikiLinks("[[Target|the alias]]");
  assert.equal(l.target, "Target");
  assert.equal(l.alias, "the alias");
  assert.equal(l.subpath, null);
});

test("wikilink with #heading suffix is stripped from the target", () => {
  const [l] = extractWikiLinks("[[Target#Some Heading]]");
  assert.equal(l.target, "Target");
  assert.equal(l.subpath, "Some Heading");
});

test("wikilink with ^block suffix is stripped from the target", () => {
  const [l] = extractWikiLinks("[[Target^blockid]]");
  assert.equal(l.target, "Target");
  assert.equal(l.subpath, "blockid");
});

test("wikilink with heading AND alias", () => {
  const [l] = extractWikiLinks("[[Target#Heading|Shown]]");
  assert.equal(l.target, "Target");
  assert.equal(l.subpath, "Heading");
  assert.equal(l.alias, "Shown");
});

test("path-style target is preserved", () => {
  assert.deepEqual(targets("[[folder/Note]]"), ["folder/Note"]);
});

test("same-note heading link yields an empty target", () => {
  const [l] = extractWikiLinks("[[#Heading]]");
  assert.equal(l.target, "");
  assert.equal(l.subpath, "Heading");
});

test("empty [[]] is not a link", () => {
  assert.deepEqual(targets("a [[]] b"), []);
});

test("multiple wikilinks on one line, with correct offsets", () => {
  const links = extractWikiLinks("x [[A]] y [[B]]");
  assert.deepEqual(
    links.map((l) => l.target),
    ["A", "B"]
  );
  assert.equal(links[0].from, 2);
  assert.equal(links[0].to, 7); // "[[A]]" is 5 chars
  assert.equal(links[0].raw, "[[A]]");
  assert.equal(links[1].from, 10);
});

test("wikilink does not span newlines", () => {
  assert.deepEqual(targets("[[Foo\nBar]]"), []);
});

// --------------------------------------------------------------------------
// Tags (same rules as the editor's Lezer Tag node)
// --------------------------------------------------------------------------

test("plain tag", () => {
  assert.deepEqual(tagNames("a #tag b"), ["tag"]);
});

test("tag with -, _ and / path chars", () => {
  assert.deepEqual(tagNames("#to-do #my_tag #project/sub"), [
    "to-do",
    "my_tag",
    "project/sub",
  ]);
});

test("'#' preceded by an alphanumeric is NOT a tag (C# / a#b)", () => {
  assert.deepEqual(tagNames("C# and a#b"), []);
});

test("tag body must contain a letter (#123 rejected, #1a accepted)", () => {
  assert.deepEqual(tagNames("#123"), []);
  assert.deepEqual(tagNames("#1a"), ["1a"]);
});

test("ATX heading '# Heading' is not a tag (space after #)", () => {
  assert.deepEqual(tagNames("# Heading"), []);
});

test("tag offsets are correct", () => {
  const [t] = extractTags("ab #note");
  assert.equal(t.tag, "note");
  assert.equal(t.from, 3);
  assert.equal(t.to, 8);
});

// --------------------------------------------------------------------------
// Code-span / fence false positives
// --------------------------------------------------------------------------

test("tag inside an inline code span is ignored", () => {
  assert.deepEqual(tagNames("real #yes but `#no` here"), ["yes"]);
});

test("wikilink inside an inline code span is ignored", () => {
  assert.deepEqual(targets("`[[NotALink]]` but [[Real]]"), ["Real"]);
});

test("refs inside a fenced code block are ignored", () => {
  const text = "```\n[[Inside]] #insidetag\n```\nafter [[Out]] #outtag";
  assert.deepEqual(targets(text), ["Out"]);
  assert.deepEqual(tagNames(text), ["outtag"]);
});

test("tilde fence is also skipped", () => {
  const text = "~~~\n#nope\n~~~\n#yep";
  assert.deepEqual(tagNames(text), ["yep"]);
});

// --------------------------------------------------------------------------
// Interaction
// --------------------------------------------------------------------------

test("a '#' suffix inside a wikilink is not extracted as a tag", () => {
  const { links, tags } = parseNote("[[Note#heading]]");
  assert.deepEqual(
    links.map((l) => l.target),
    ["Note"]
  );
  assert.deepEqual(tags, []);
});

test("links and tags coexist on a line", () => {
  const { links, tags } = parseNote("see [[Foo]] about #bar");
  assert.deepEqual(
    links.map((l) => l.target),
    ["Foo"]
  );
  assert.deepEqual(
    tags.map((t) => t.tag),
    ["bar"]
  );
});

// --------------------------------------------------------------------------
// Edge cases that pin the exact rules (mutation-hardening)
// --------------------------------------------------------------------------

test("tag char-class boundaries (isAlnum / isAlpha) are exact", () => {
  // every boundary char must count as a tag-body char (extends the tag)
  for (const c of ["0", "9", "A", "Z", "a", "z"])
    assert.deepEqual(tagNames("#x" + c), ["x" + c], `'${c}' should extend a tag`);
  // every boundary LETTER alone satisfies the "needs a letter" rule
  for (const c of ["A", "Z", "a", "z"])
    assert.deepEqual(tagNames("#" + c), [c], `'${c}' alone is a valid tag`);
  // a '#' preceded by any alphanumeric boundary char is NOT a tag
  for (const c of ["0", "9", "A", "Z", "a", "z"])
    assert.deepEqual(tagNames(c + "#nope"), [], `'${c}#' must not start a tag`);
});

test("inline code: a double-backtick span masks refs inside it", () => {
  assert.deepEqual(tagNames("``#no`` and #yes"), ["yes"]);
});

test("inline code: a wrong-length inner run does not close the span", () => {
  // open ` (len 1); the `` (len 2) inside can't close; the final ` (len 1) does.
  assert.deepEqual(tagNames("`a``#x`b #yes"), ["yes"]);
});

test("inline code: an unterminated backtick is literal (refs after it count)", () => {
  assert.deepEqual(tagNames("`unterminated #real"), ["real"]);
  assert.deepEqual(targets("`unterminated [[Real]]"), ["Real"]);
});

test("wikilink parts are trimmed (target / alias / subpath)", () => {
  const [l] = extractWikiLinks("[[  Target  |  Alias  ]]");
  assert.equal(l.target, "Target");
  assert.equal(l.alias, "Alias");
  const [l2] = extractWikiLinks("[[ Note # Heading ]]");
  assert.equal(l2.target, "Note");
  assert.equal(l2.subpath, "Heading");
});

test("a tag at the very start of the text is extracted (prev = none)", () => {
  assert.deepEqual(tagNames("#start of line"), ["start"]);
});

test("a lone '#' with no body is not a tag", () => {
  assert.deepEqual(tagNames("a # b"), []);
  assert.deepEqual(tagNames("#"), []);
});

test("an unclosed '[[' is not a link", () => {
  assert.deepEqual(targets("text [[ unclosed"), []);
  assert.deepEqual(targets("trailing ["), []);
});

test("a non-tag char stops the tag; a non-alnum char before '#' allows it", () => {
  assert.deepEqual(tagNames("#a.b"), ["a"]); // '.' is not a tag char → stops at 'a'
  assert.deepEqual(tagNames(".#tag"), ["tag"]); // '.' before '#' is not alnum → tag fires
});

test("a '#' immediately AFTER a wikilink is a tag (inWiki is half-open)", () => {
  const { links, tags } = parseNote("[[A]]#tag");
  assert.deepEqual(links.map((l) => l.target), ["A"]);
  assert.deepEqual(tags.map((t) => t.tag), ["tag"]);
});

test("a wikilink needs BOTH closing brackets", () => {
  assert.deepEqual(targets("[[x]"), []); // only one ]
  assert.deepEqual(targets("a [x]] b"), []); // only one [
});

test("a ref immediately after a closed code span is extracted", () => {
  assert.deepEqual(tagNames("`c`#tag"), ["tag"]);
  assert.deepEqual(targets("`c`[[L]]"), ["L"]);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll linkParser tests passed");

// Pure-logic tests for the image/attachment resolver (no VS Code). This is the
// bulk of the "open an Obsidian vault → images resolve" correctness surface.
import assert from "node:assert";
import {
  buildSnapshot,
  makeEntry,
  parseEmbedInner,
  resolveImageRef,
  IMAGE_EXTS,
  type ImageSnapshot,
} from "../../src/extension/vault/imageResolver";

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

// helpers
const snap = (paths: string[]): ImageSnapshot => buildSnapshot(paths);
/** Resolve an EMBED (`![[pathPart]]`) → matched relPath or null. */
const embed = (s: ImageSnapshot, dir: string[], p: string): string | null =>
  resolveImageRef(s, dir, p, true)?.relPath ?? null;
/** Resolve a MARKDOWN src (`![](src)`) → matched relPath or null. */
const md = (s: ImageSnapshot, dir: string[], p: string): string | null =>
  resolveImageRef(s, dir, p, false)?.relPath ?? null;

// --- bare basename / vault-wide -------------------------------------------

test("bare embed resolves vault-wide to an attachments-folder image", () => {
  const s = snap(["attachments/pic.png"]);
  assert.equal(embed(s, ["notes"], "pic.png"), "attachments/pic.png");
});

test("exact document-relative beats a vault-wide basename match", () => {
  const s = snap(["notes/pic.png", "attachments/pic.png"]);
  assert.equal(embed(s, ["notes"], "pic.png"), "notes/pic.png");
});

test("same-folder image for a nested note resolves (doc-relative exact)", () => {
  const s = snap(["a/b/pic.png"]);
  assert.equal(embed(s, ["a", "b"], "pic.png"), "a/b/pic.png");
});

test("markdown ![](bare.png) with no relative hit falls back to basename", () => {
  const s = snap(["attachments/pic.png"]);
  assert.equal(md(s, ["notes"], "pic.png"), "attachments/pic.png");
});

// --- path hints (foldered) -------------------------------------------------

test("a foldered reference resolves by path-hint (suffix), not arbitrary basename", () => {
  const s = snap(["a/sub/pic.png", "b/pic.png"]);
  assert.equal(embed(s, [], "sub/pic.png"), "a/sub/pic.png");
});

test("a foldered reference does NOT fall back to a bare basename match", () => {
  const s = snap(["x/pic.png"]); // no path ends with sub/pic.png
  assert.equal(embed(s, [], "sub/pic.png"), null);
});

// --- duplicate ranking -----------------------------------------------------

test("duplicate basenames: the shorter path wins", () => {
  const s = snap(["deep/folder/pic.png", "pic.png"]);
  assert.equal(embed(s, [], "pic.png"), "pic.png");
});

test("duplicate basenames: exact-case basename beats a case-only match", () => {
  const s = snap(["a/Pic.png", "b/pic.png"]);
  assert.equal(embed(s, [], "pic.png"), "b/pic.png");
  assert.equal(embed(s, [], "Pic.png"), "a/Pic.png");
});

// --- spaces / percent-encoding --------------------------------------------

test("embed with raw spaces resolves", () => {
  const s = snap(["attachments/my pic.png"]);
  assert.equal(embed(s, ["notes"], "my pic.png"), "attachments/my pic.png");
});

test("markdown percent-encoded spaces resolve (decoded for lookup)", () => {
  const s = snap(["attachments/my pic.png"]);
  assert.equal(md(s, ["notes"], "my%20pic.png"), "attachments/my pic.png");
});

// --- extension rules -------------------------------------------------------

test("extensionless embed ![[Photo]] is NOT guessed to an image", () => {
  const s = snap(["attachments/Photo.png"]);
  assert.equal(embed(s, [], "Photo"), null);
});

test("a non-image embed extension (.md/.pdf) is not resolved as an image", () => {
  const s = snap(["attachments/doc.md", "attachments/file.pdf"]);
  assert.equal(embed(s, [], "doc.md"), null);
  assert.equal(embed(s, [], "file.pdf"), null);
});

test("the supported image extension set is exactly Obsidian's", () => {
  assert.deepEqual(
    [...IMAGE_EXTS].sort(),
    ["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]
  );
});

// --- relative markers ------------------------------------------------------

test("./ and ../ are relative-ONLY (no vault-wide fallback)", () => {
  const s = snap(["notes/sub/pic.png", "attachments/pic.png"]);
  assert.equal(embed(s, ["notes"], "./sub/pic.png"), "notes/sub/pic.png");
  assert.equal(embed(s, ["notes"], "../attachments/pic.png"), "attachments/pic.png");
  assert.equal(embed(s, ["notes"], "./missing.png"), null); // relative miss → null, NOT basename
});

// --- Windows-style stored paths -------------------------------------------

test("entries with backslash separators normalize correctly", () => {
  const e = makeEntry("a\\b\\pic.png");
  assert.deepEqual(e.segments, ["a", "b", "pic.png"]);
  assert.equal(e.basename, "pic.png");
  const s = snap(["a\\b\\pic.png"]);
  assert.equal(embed(s, [], "pic.png"), "a/b/pic.png");
});

// --- embed inner parsing (#anchor / |size) --------------------------------

test("parseEmbedInner pulls the path part and |WxH dimensions", () => {
  assert.deepEqual(parseEmbedInner("img.png"), { pathPart: "img.png", width: undefined, height: undefined });
  assert.deepEqual(parseEmbedInner("img.png|200"), { pathPart: "img.png", width: 200, height: undefined });
  assert.deepEqual(parseEmbedInner("img.png|100x145"), { pathPart: "img.png", width: 100, height: 145 });
  assert.deepEqual(parseEmbedInner("img.png#anchor|200"), { pathPart: "img.png", width: 200, height: undefined });
  // a non-numeric alias is not a size; path part still extracted
  assert.equal(parseEmbedInner("img.png|alt text").pathPart, "img.png");
  assert.equal(parseEmbedInner("sub/img.png#x").pathPart, "sub/img.png");
});

test("an absolute path is never vault-resolved (POSIX / Windows / UNC)", () => {
  const s = snap(["attachments/logo.png"]);
  assert.equal(md(s, ["notes"], "/tmp/logo.png"), null); // POSIX
  assert.equal(embed(s, ["notes"], "/var/logo.png"), null);
  assert.equal(md(s, ["notes"], "C:/Users/me/logo.png"), null); // Windows drive
  assert.equal(md(s, ["notes"], "\\\\server\\share\\logo.png"), null); // UNC
});

// --- snapshot status -------------------------------------------------------

test("a non-ready snapshot resolves nothing (caller uses legacy fallback)", () => {
  for (const status of ["notReady", "overCap", "disabled"] as const) {
    const s = buildSnapshot(["attachments/pic.png"], status);
    assert.equal(embed(s, ["notes"], "pic.png"), null);
  }
});

if (failed > 0) {
  console.error(`\n${failed} imageResolver test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll imageResolver tests passed");

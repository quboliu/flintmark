// L1 unit tests for the image-attachment filename helper
// (src/extension/vault/attachment.ts). Pure, host-side, no vscode.
import assert from "node:assert";
import { attachmentName, dedupeName } from "../../src/extension/vault/attachment";

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

test("keeps a real image filename", () => {
  assert.equal(attachmentName("photo.png", "image/png", "S"), "photo.png");
});

test("no filename → stamped fallback, extension from MIME", () => {
  assert.equal(attachmentName("", "image/png", "20260101"), "Pasted image 20260101.png");
});

test("jpeg is normalized to jpg (from filename or MIME)", () => {
  assert.equal(attachmentName("pic.JPEG", "", "S"), "pic.jpg");
  assert.equal(attachmentName("x", "image/jpeg", "S"), "x.jpg");
});

test("extension comes from MIME when the filename has none", () => {
  assert.equal(attachmentName("clip", "image/webp", "S"), "clip.webp");
});

test("non-image input → null (host refuses to write it)", () => {
  assert.equal(attachmentName("doc.pdf", "application/pdf", "S"), null);
  assert.equal(attachmentName("evil.exe", "application/octet-stream", "S"), null);
  assert.equal(attachmentName("", "text/plain", "S"), null);
});

test("basename only — directories / traversal are stripped", () => {
  assert.equal(attachmentName("a/b/evil.png", "image/png", "S"), "evil.png");
  assert.equal(attachmentName("../../e.png", "image/png", "S"), "e.png");
});

test("filename-illegal characters are stripped", () => {
  assert.equal(attachmentName("a:b.png", "image/png", "S"), "ab.png");
  assert.equal(attachmentName('a"b*c.png', "image/png", "S"), "abc.png");
});

test("wikilink-breaking chars (#, [, ], ^) are stripped from the embed name", () => {
  // Otherwise ![[diagram#1.png]] resolves to 'diagram' (embed splits on #).
  assert.equal(attachmentName("diagram#1.png", "image/png", "S"), "diagram1.png");
  assert.equal(attachmentName("a[b]^c.png", "image/png", "S"), "abc.png");
});

test("dedupeName inserts -n before the extension", () => {
  assert.equal(dedupeName("photo.png", 2), "photo-2.png");
  assert.equal(dedupeName("Pasted image 1.jpg", 3), "Pasted image 1-3.jpg");
});

if (failed > 0) {
  console.error(`\n${failed} attachment test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll attachment tests passed");

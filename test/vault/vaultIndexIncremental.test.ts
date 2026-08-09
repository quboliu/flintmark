import assert from "node:assert";
import {
  buildVaultIndex,
  type NoteInput,
  type VaultIndex,
} from "../../src/extension/vault/vaultIndex";

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

function snapshot(index: VaultIndex): unknown {
  const notes = index.getAllNotes();
  return {
    notes,
    graph: notes.map((note) => ({
      path: note.path,
      outgoing: index.getOutgoingLinks(note.path),
      unresolved: index.getUnresolvedLinks(note.path),
      backlinks: index.getBacklinks(note.path),
    })),
    tags: index.getAllTags().map((tag) => ({ tag, paths: index.getTagged(tag) })),
  };
}

test("replaceNoteContent removes old graph/tag contributions and adds new ones", () => {
  const index = buildVaultIndex([
    { path: "A.md", text: "[[B]] #old" },
    { path: "B.md", text: "" },
    { path: "C.md", text: "" },
  ]);
  assert.equal(index.replaceNoteContent({ path: "A.md", text: "[[C]] [[Ghost]] #new" }), true);
  assert.deepEqual(index.getOutgoingLinks("A.md"), ["C.md"]);
  assert.deepEqual(index.getBacklinks("B.md"), []);
  assert.deepEqual(index.getBacklinks("C.md"), ["A.md"]);
  assert.deepEqual(index.getUnresolvedLinks("A.md"), ["Ghost"]);
  assert.deepEqual(index.getTagged("old"), []);
  assert.deepEqual(index.getTagged("new"), ["A.md"]);
  assert.equal(index.replaceNoteContent({ path: "Missing.md", text: "#x" }), false);
});

test("random content-only sequences stay deep-equal to a full rebuild after every step", () => {
  const random = mulberry32(0x5eedc0de);
  for (let vaultRun = 0; vaultRun < 30; vaultRun++) {
    const noteCount = 8 + Math.floor(random() * 18);
    const inputs: NoteInput[] = Array.from({ length: noteCount }, (_, i) => ({
      path: `folder-${i % 4}/Note-${i}.md`,
      text: randomText(random, noteCount),
    }));
    const incremental = buildVaultIndex(inputs.map((input) => ({ ...input })));
    for (let operation = 0; operation < 35; operation++) {
      const changed = Math.floor(random() * noteCount);
      inputs[changed] = { ...inputs[changed], text: randomText(random, noteCount) };
      assert.equal(incremental.replaceNoteContent(inputs[changed]), true);
      const rebuilt = buildVaultIndex(inputs.map((input) => ({ ...input })));
      assert.deepEqual(
        snapshot(incremental),
        snapshot(rebuilt),
        `vaultRun=${vaultRun}, operation=${operation}, changed=${changed}`
      );
    }
  }
});

function randomText(random: () => number, noteCount: number): string {
  const parts: string[] = [];
  const links = Math.floor(random() * 7);
  for (let i = 0; i < links; i++) {
    if (random() < 0.18) parts.push("[[Ghost]]");
    else if (random() < 0.12) parts.push("[[#Local heading]]");
    else {
      const target = Math.floor(random() * noteCount);
      const suffix = random() < 0.35 ? "#Section|alias" : "";
      parts.push(`[[Note-${target}${suffix}]]`);
    }
  }
  const tags = ["alpha", "Beta", "gamma", "todo", "project"];
  const tagCount = Math.floor(random() * 6);
  for (let i = 0; i < tagCount; i++) parts.push(`#${tags[Math.floor(random() * tags.length)]}`);
  parts.push(`body-${Math.floor(random() * 1_000_000)}`);
  return parts.join(" ");
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

if (failed > 0) {
  console.error(`\n${failed} incremental vault-index test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll incremental vault-index tests passed");

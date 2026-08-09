import assert from "node:assert";
import { patchNoteSnapshot } from "../../src/extension/vault/vaultSnapshot";

let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log("  ✓ " + name);
  } catch (error) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (error as Error).message);
  }
}

async function main(): Promise<void> {
await test("one content save reads exactly one file and retains other snapshot entries", async () => {
  const snapshot = {
    inputs: new Map([
      ["A.md", { path: "A.md", text: "old A" }],
      ["B.md", { path: "B.md", text: "old B" }],
    ]),
    uris: new Map([
      ["A.md", "A.md"],
      ["B.md", "B.md"],
    ]),
  };
  let reads = 0;
  const patched = await patchNoteSnapshot(
    snapshot,
    ["A.md"],
    (uri) => uri,
    async () => {
      reads++;
      return "new A";
    },
    () => {}
  );
  assert.equal(reads, 1);
  assert.equal(patched?.inputs.get("A.md")?.text, "new A");
  assert.equal(patched?.inputs.get("B.md")?.text, "old B");
  assert.equal(snapshot.inputs.get("A.md")?.text, "old A", "publication must be copy-on-write");
});

await test("missing or unreadable content path requests a full fallback", async () => {
  const snapshot = {
    inputs: new Map([["A.md", { path: "A.md", text: "old" }]]),
    uris: new Map([["A.md", "A.md"]]),
  };
  let reads = 0;
  assert.equal(
    await patchNoteSnapshot(snapshot, ["Missing.md"], (uri) => uri, async () => {
      reads++;
      return "unused";
    }, () => {}),
    undefined
  );
  assert.equal(reads, 0);
  assert.equal(
    await patchNoteSnapshot(snapshot, ["A.md"], (uri) => uri, async () => {
      reads++;
      throw new Error("deleted during save");
    }, () => {}),
    undefined
  );
  assert.equal(reads, 1);
});

if (failed > 0) {
  console.error(`\n${failed} vault snapshot test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll vault snapshot tests passed");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

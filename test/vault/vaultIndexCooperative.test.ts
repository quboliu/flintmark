import assert from "node:assert";
import {
  buildVaultIndex,
  buildVaultIndexCooperatively,
  VaultIndexBuildCancelled,
  type NoteInput,
  type VaultIndex,
} from "../../src/extension/vault/vaultIndex";

let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log("  ✓ " + name);
  } catch (error) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (error as Error).stack);
  }
}

function snapshot(index: VaultIndex): unknown {
  const notes = index.getAllNotes();
  return {
    notes,
    tags: index.getAllTags(),
    byNote: notes.map((note) => ({
      path: note.path,
      outgoing: index.getOutgoingLinks(note.path),
      backlinks: index.getBacklinks(note.path),
      unresolved: index.getUnresolvedLinks(note.path),
    })),
    resolution: ["Alpha", "folder/Beta", "Missing"].map((name) => [
      name,
      index.resolveLink(name),
    ]),
  };
}

const inputs: NoteInput[] = Array.from({ length: 120 }, (_, i) => ({
  path: i === 1 ? "folder/Beta.md" : `notes/Note-${i}.md`,
  text:
    i === 0
      ? "#one [[folder/Beta]] [[Missing]]"
      : `#tag-${i % 9} [[Note-${(i + 1) % 120}]] [[Note-${(i + 7) % 120}]]`,
}));
inputs.push({ path: "Alpha.md", text: "#alpha [[Note-0]]" });

async function main(): Promise<void> {
await test("cooperative build yields to a setImmediate before completing", async () => {
  let clock = 0;
  let externalTaskRan = false;
  let completed = false;
  const promise = buildVaultIndexCooperatively(inputs, {
    now: () => ++clock,
    yieldNow: () => new Promise<void>((resolve) => setImmediate(resolve)),
    shouldCancel: () => false,
    maxSliceMs: 3,
  }).then((value) => {
    completed = true;
    return value;
  });

  setImmediate(() => {
    externalTaskRan = !completed;
  });

  await promise;
  assert.equal(externalTaskRan, true, "event-loop work should run during the build");
});

await test("cooperative and synchronous builds are query-equivalent", async () => {
  let clock = 0;
  const cooperative = await buildVaultIndexCooperatively(inputs, {
    now: () => ++clock,
    yieldNow: () => Promise.resolve(),
    shouldCancel: () => false,
    maxSliceMs: 4,
  });
  assert.deepEqual(snapshot(cooperative), snapshot(buildVaultIndex(inputs)));
});

await test("cooperative cancellation rejects without returning a partial index", async () => {
  let clock = 0;
  let cancelled = false;
  await assert.rejects(
    buildVaultIndexCooperatively(inputs, {
      now: () => ++clock,
      yieldNow: async () => {
        cancelled = true;
      },
      shouldCancel: () => cancelled,
      maxSliceMs: 2,
    }),
    (error: unknown) => error instanceof VaultIndexBuildCancelled
  );
});

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll cooperative vault-index tests passed");
}

void main();

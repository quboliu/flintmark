import assert from "node:assert";
import {
  isAutoSourceRevealSuppressed,
  suppressAutoSourceReveal,
} from "../../src/extension/sourceRevealBridge";

type UriLike = Parameters<typeof suppressAutoSourceReveal>[0];

function uri(value: string): UriLike {
  return { toString: () => value } as UriLike;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let failed = 0;
const cases: { name: string; fn: () => Promise<void> | void }[] = [];
const test = (name: string, fn: () => Promise<void> | void) => cases.push({ name, fn });

test("suppressed URI reports true while the suppression window is active", () => {
  const note = uri("file:///vault/note.md");
  suppressAutoSourceReveal(note, 100);
  assert.equal(isAutoSourceRevealSuppressed(note), true);
});

test("suppression is isolated per URI", () => {
  suppressAutoSourceReveal(uri("file:///vault/a.md"), 100);
  assert.equal(isAutoSourceRevealSuppressed(uri("file:///vault/b.md")), false);
});

test("expired suppression reports false and clears itself", async () => {
  const note = uri("file:///vault/expired.md");
  suppressAutoSourceReveal(note, 1);
  await sleep(5);
  assert.equal(isAutoSourceRevealSuppressed(note), false);
  assert.equal(isAutoSourceRevealSuppressed(note), false);
});

async function main(): Promise<void> {
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`  ✓ ${c.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${c.name}`);
      console.error(err);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} sourceRevealBridge test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll sourceRevealBridge tests passed");
}

void main();

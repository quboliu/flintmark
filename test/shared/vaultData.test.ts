import assert from "node:assert";
import { copyVaultData } from "../../src/shared/vaultData";

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

test("VaultData callers cannot mutate the cached arrays", () => {
  const cached = { notes: ["Alpha"], tags: ["project"] };
  const first = copyVaultData(cached);
  first.notes.length = 0;
  first.tags.push("pollution");

  assert.deepEqual(copyVaultData(cached), {
    notes: ["Alpha"],
    tags: ["project"],
  });
});

if (failed > 0) {
  console.error(`\n${failed} VaultData test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll VaultData tests passed");

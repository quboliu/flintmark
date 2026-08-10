import assert from "node:assert";
import { waitForVaultBuildGate } from "../../src/extension/vault/vaultBuildGate";

async function main(): Promise<void> {
  const states = [true, true, false];
  let waits = 0;
  await waitForVaultBuildGate("/controlled/gate", {
    exists: () => states.shift() ?? false,
    wait: async () => {
      waits++;
    },
  });

  assert.equal(waits, 2);
  console.log("  ✓ a controlled vault build gate blocks until explicitly released");
  console.log("\nAll vault build gate tests passed");
}

void main().catch((error) => {
  console.error("  ✗ a controlled vault build gate blocks until explicitly released\n      " + error.message);
  process.exit(1);
});

import assert from "node:assert";
import { readFileSync } from "node:fs";

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

test("an E2E retry is visibly distinguished from a clean first-pass", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.equal(
    workflow.includes("npm run test:e2e || npm run test:e2e"),
    false,
    "silent A || A retry must not return"
  );
  assert.match(workflow, /::warning[^\n]*E2E/i);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
});

if (failed > 0) {
  console.error(`\n${failed} CI workflow test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll CI workflow tests passed");

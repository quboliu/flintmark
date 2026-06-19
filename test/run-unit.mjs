// Runs every pure-logic test (test/**/*.test.ts, excluding integration/) in
// Node: bundles each with esbuild then executes it in an isolated process so a
// process.exit in one file doesn't stop the others. The bottom of docs/05.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== "integration") walk(p, acc);
    } else if (p.endsWith(".test.ts")) {
      acc.push(p);
    }
  }
  return acc;
}

const files = walk("test");
if (files.length === 0) {
  console.log("No unit tests found.");
  process.exit(0);
}

mkdirSync("out/test-unit", { recursive: true });

let failed = 0;
for (const f of files) {
  const outfile = join(
    "out/test-unit",
    f.replace(/[/\\]/g, "__").replace(/\.ts$/, ".cjs")
  );
  await build({
    entryPoints: [f],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    sourcemap: "inline",
    logLevel: "warning",
  });
  console.log(`\n• ${f}`);
  try {
    execFileSync(process.execPath, [outfile], { stdio: "inherit" });
  } catch {
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} unit test file(s) FAILED`);
  process.exit(1);
}
console.log("\nAll unit test files passed");

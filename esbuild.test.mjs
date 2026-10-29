// Bundles integration tests and project sources as CommonJS for the extension
// host. Packages such as vscode/mocha/glob and Node builtins resolve at runtime.
import esbuild from "esbuild";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const outputRoot = process.env.FLINTMARK_OUT_DIR || "out";

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

await esbuild.build({
  entryPoints: walk("test/integration"),
  outdir: join(outputRoot, "test"),
  outbase: "test/integration",
  platform: "node",
  format: "cjs",
  bundle: true,
  packages: "external",
  sourcemap: "inline",
  target: "node18",
});

console.log("[esbuild] integration test build complete");

// L2 integration test entry (docs/05). Launches a REAL VS Code-family editor
// (VSCodium by default, reused locally to avoid a download) headless under
// xvfb, loads this extension in development mode, and runs the Mocha suite
// inside the extension host.
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  // out/test/runTest.js -> repo root is two levels up.
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");

  // Reuse the locally-installed VSCodium electron binary; override with VSCODE_BIN.
  const vscodeExecutablePath =
    process.env.VSCODE_BIN || "/usr/share/codium/codium";

  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-workspace-trust",
      ],
    });
  } catch (err) {
    console.error("Integration tests failed:", err);
    process.exit(1);
  }
}

void main();

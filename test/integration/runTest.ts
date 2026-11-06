// L2 integration test entry (docs/05). Launches a REAL VS Code-family editor
// (VSCodium by default, reused locally to avoid a download) headless under
// xvfb, loads this extension in development mode, and runs the Mocha suite
// inside the extension host.
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  // out/test/runTest.js -> repo root is two levels up.
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");

  // Reuse the locally-installed VSCodium electron binary; override with VSCODE_BIN.
  const vscodeExecutablePath =
    process.env.VSCODE_BIN || "/usr/share/codium/codium";

  // An explicit workspace opens the editor workbench in every supported host.
  // In particular, Cursor's empty-window entry can open its agent landing page.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "flintmark-integration-"));
  const profile = path.join(work, "profile");
  const initialFile = path.join(work, "integration.md");
  fs.mkdirSync(path.join(profile, "User"), {recursive:true});
  fs.writeFileSync(initialFile, "# Integration workspace\n");
  fs.writeFileSync(path.join(profile, "User", "settings.json"), JSON.stringify({
    "workbench.startupEditor":"none", "security.workspace.trust.enabled":false,
    "update.mode":"none", "telemetry.telemetryLevel":"off",
    "extensions.autoUpdate":false, "extensions.autoCheckUpdates":false,
  }));

  const reports = path.join(process.env.FLINTMARK_OUT || work, "integration-reports");
  fs.mkdirSync(reports, {recursive:true});
  process.env.FLINTMARK_INTEGRATION_REPORT_DIR = reports;
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        work, initialFile,
        `--user-data-dir=${profile}`,
        `--extensions-dir=${path.join(work, "extensions")}`,
        "--skip-welcome", "--skip-release-notes",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-workspace-trust",
      ],
    });
    // Some editor variants return zero even when their test host fails.
    // Require independent, complete Mocha evidence from every invoked host.
    const files = fs.readdirSync(reports).filter(name => /^host-.*\.json$/.test(name));
    if (files.length !== 1) throw new Error(`Expected one test host, found ${files.length}`);
    for (const name of files) {
      const report = JSON.parse(fs.readFileSync(path.join(reports, name), "utf8"));
      if (!report.completed || report.failures !== 0 || report.stats?.passes !== 51 || report.stats?.pending !== 0)
        throw new Error(`Incomplete or failed integration report: ${JSON.stringify(report)}`);
    }
  } catch (err) {
    console.error("Integration tests failed:", err);
    process.exit(1);
  }
}

void main();

// Mocha runner executed INSIDE the VS Code extension host (via extensionTestsPath).
import Mocha from "mocha";
import { glob } from "glob";
import * as path from "node:path";
import * as fs from "node:fs";

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", color: true, timeout: 60000 });
  const testsRoot = __dirname;

  const files = await glob("**/*.test.js", { cwd: testsRoot });
  for (const f of files) {
    mocha.addFile(path.resolve(testsRoot, f));
  }

  const reportDir = process.env.FLINTMARK_INTEGRATION_REPORT_DIR;
  const reportFile = reportDir ? path.join(reportDir, `host-${process.pid}.json`) : undefined;
  if (reportDir) fs.mkdirSync(reportDir, {recursive:true});
  if (reportFile) fs.writeFileSync(reportFile, JSON.stringify({completed:false}));
  await new Promise<void>((resolve, reject) => {
    const runner = mocha.run((failures) => {
      if (reportFile) fs.writeFileSync(reportFile, JSON.stringify({completed:true,failures,stats:runner.stats}));
      if (failures > 0) reject(new Error(`${failures} test(s) failed`));
      else resolve();
    });
  });
}

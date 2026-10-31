// Real-editor regressions for issues #5, #10, #14 and PR #6.
import { _electron as electron } from "playwright";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { palette } from "./quickInput.mjs";

const repo = resolve(".");
const work = mkdtempSync(join(tmpdir(), "flintmark-issues-"));
const userData = join(work, "user-data");
mkdirSync(join(userData, "User"), { recursive: true });
writeFileSync(join(userData, "User/settings.json"), JSON.stringify({
  "workbench.editorAssociations": { "*.md": "ofm.livePreview" },
  "security.workspace.trust.enabled": false,
  "workbench.startupEditor": "none",
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
}));
mkdirSync(join(work, "notes/common"), { recursive: true });
mkdirSync(join(work, "common"), { recursive: true });
writeFileSync(join(work, "common/target.md"), "# Wrong workspace target\n");
writeFileSync(join(work, "notes/common/target.md"), "# Correct relative target\n");
writeFileSync(join(work, "notes/common/Other Note.markdown"), "# Encoded relative target\n");
const variables = "四轮垂向作用力 Fz_FL 、 Fz_FR 、 Fz_RL 、 Fz_RR";
writeFileSync(join(work, "notes/regressions.md"), [
  "# Regression fixtures", "",
  variables, "", "A [body relative](common/target.md) link.", "",
  "| Variables | Links |", "| --- | --- |",
  "| " + variables + " | [open relative](common/target.md) |",
  "| _italic_ | [encoded note](common/Other%20Note.markdown) |",
  "| plain | [[common/target.md]] |", "", "plain tail", "",
].join("\n"));
writeFileSync(join(work, "windows.md"), "# Windows title\r\n\r\n## Second title\r\n");
const crlfNote = join(work, "crlf-edit.md");
writeFileSync(crlfNote, "# CRLF edit\r\n\r\n- aaa\r\n- bbb\r\n- ccc\r\n");
writeFileSync(join(work, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
writeFileSync(join(work, "image-only.md"), "![pixel](pixel.png)");
const app = await electron.launch({
  executablePath: process.env.VSCODE_BIN || "/usr/share/codium/codium",
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--user-data-dir=" + userData, "--extensions-dir=" + join(work, "ext"),
    "--extensionDevelopmentPath=" + repo, work],
});
try {
  const win = await app.firstWindow();
  await win.waitForSelector(".monaco-workbench", { timeout: 30000 });
  await win.waitForTimeout(4000);
  async function frameFor(marker) {
    for (let i = 0; i < 50; i++) {
      for (const frame of win.frames()) {
        try {
          if (await frame.locator(".cm-content").count() &&
              (await frame.locator(".cm-content").innerText()).includes(marker)) return frame;
        } catch {}
      }
      await win.waitForTimeout(200);
    }
    throw Error("No Live Preview frame for " + marker);
  }
  async function open(file, marker) {
    await palette(win, "Control+p", file);
    return frameFor(marker);
  }
  let cm = await open("notes/regressions.md", "Regression fixtures");
  const table = cm.locator(".ofm-table-wrap:not(.ofm-table-measure-rack *) table").first();
  await table.waitFor({ state: "visible", timeout: 15000 });
  const variableCell = table.locator("tbody tr").nth(0).locator("td").nth(0);
  assert.equal(await variableCell.innerText(), variables);
  assert.equal(await variableCell.locator(".ofm-emphasis").count(), 0);
  assert.equal(await table.locator("tbody tr").nth(1).locator(".ofm-emphasis").innerText(), "italic");
  console.log("  ✓ variable underscores stay literal while explicit italics render");

  await table.locator("[data-ofm-link='common/target.md']").first().click();
  await frameFor("Correct relative target");
  assert.equal(readFileSync(join(work, "notes/regressions.md"), "utf8").includes("[open relative]"), true);
  console.log("  ✓ table Markdown links open the document-relative target without editing the cell");

  cm = await open("notes/regressions.md", "Regression fixtures");
  await cm.locator(".ofm-table-wrap:not(.ofm-table-measure-rack *) [data-ofm-link='common/Other%20Note.markdown']").first().click();
  await frameFor("Encoded relative target");
  console.log("  ✓ percent-encoded .markdown targets resolve without a doubled extension");

  cm = await open("notes/regressions.md", "Regression fixtures");
  await cm.getByText("body relative", { exact: true }).click();
  await frameFor("Correct relative target");
  console.log("  ✓ body Markdown links use the same relative resolution");

  cm = await open("notes/regressions.md", "Regression fixtures");
  await cm.locator(".ofm-table-wrap:not(.ofm-table-measure-rack *) .ofm-internal-link").first().click();
  await frameFor("Correct relative target");
  console.log("  ✓ table wikilinks dispatch through the widget event boundary");

  cm = await open("windows.md", "Windows title");
  await win.locator('.activitybar a[aria-label*="Flintmark"]').first().click();
  await win.getByText("Windows title", { exact: true }).first().waitFor({ state: "visible" });
  await win.getByText("Second title", { exact: true }).first().waitFor({ state: "visible" });
  await win.getByText("Second title", { exact: true }).first().click();
  console.log("  ✓ Windows CRLF headings appear by name in the Outline sidebar");

  cm = await open("crlf-edit.md", "CRLF edit");
  await cm.locator(".cm-line", { hasText: "bbb" }).click();
  await win.keyboard.press("End");
  await win.keyboard.type("XYZ");
  await cm.locator(".cm-line", { hasText: "ccc" }).click();
  await win.keyboard.press("End");
  await win.keyboard.press("Backspace");
  await win.keyboard.press("Enter");
  await win.keyboard.type("ddd");
  await win.keyboard.press("Control+s");
  const expected = "# CRLF edit\r\n\r\n- aaa\r\n- bbbXYZ\r\n- cc\r\n- ddd\r\n";
  for (let i = 0; i < 50 && readFileSync(crlfNote, "utf8") !== expected; i++) await win.waitForTimeout(200);
  assert.equal(JSON.stringify(readFileSync(crlfNote, "utf8")), JSON.stringify(expected));
  console.log("  ✓ typing, Backspace and Enter in a CRLF note edit the right place on disk");

  await palette(win, "Control+p", "image-only.md");
  let image = null;
  for (let i = 0; i < 50 && !image; i++) {
    for (const frame of win.frames()) {
      const candidate = frame.locator(".cm-content img.ofm-image").first();
      if (await candidate.count().catch(() => 0)) image = candidate;
    }
    if (!image) await win.waitForTimeout(200);
  }
  assert.ok(image, "a single-line image with no trailing newline must render on open");
  console.log("  ✓ an image-only note renders before the first interaction");
} finally {
  await app.close();
}

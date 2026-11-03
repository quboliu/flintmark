// Real-editor data integrity: delayed concurrent panels, immediate save, EOLs.
import { _electron as electron } from "playwright";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { palette } from "./quickInput.mjs";
const work = mkdtempSync(join(tmpdir(), "flintmark-sync-"));
const output = process.env.FLINTMARK_SYNC_EVIDENCE || work;
mkdirSync(output, { recursive: true });
const userData = join(work, "profile");
mkdirSync(join(userData, "User"), { recursive: true });
writeFileSync(
  join(userData, "User/settings.json"),
  JSON.stringify({
    "workbench.editorAssociations": { "*.md": "ofm.livePreview" },
    "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none",
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
  }),
);
const app = await electron.launch({
  executablePath: process.env.VSCODE_BIN || "/usr/share/codium/codium",
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--user-data-dir=" + userData,
    "--extensions-dir=" + join(work, "ext"),
    "--extensionDevelopmentPath=" + resolve("."),
    work,
  ],
});
let win;
const records = [],
  errors = [];
const text = (f) =>
  f.evaluate(() =>
    document.querySelector(".cm-content").cmTile.root.view.state.doc.toString(),
  );
async function focus(f, line) {
  await f.evaluate((line) => {
    const v = document.querySelector(".cm-content").cmTile.root.view;
    const at = line ? v.state.doc.line(line).to : v.state.doc.length;
    v.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    v.focus();
  }, line);
}
async function waitFor(fn, message) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await win.waitForTimeout(100);
  }
  throw Error(message);
}
async function frames(marker) {
  const list = [];
  for (const f of win.frames()) {
    try {
      if (
        (await text(f)).startsWith("# " + marker + "\n") &&
        (await f.locator(".cm-content").isVisible())
      )
        list.push(f);
    } catch {}
  }
  return list;
}
async function open(name, marker) {
  await palette(win, "Control+p", name);
  await waitFor(
    async () => (await frames(marker)).length > 0,
    "No editor for " + marker,
  );
  return (await frames(marker))[0];
}
try {
  win = await app.firstWindow();
  win.on("pageerror", (e) => errors.push(String(e)));
  await win.waitForSelector(".monaco-workbench");
  await win.waitForTimeout(3000);
  for (const eol of ["LF", "CRLF"]) {
    const sep = eol === "LF" ? "\n" : "\r\n",
      marker = eol + " synchronized",
      name = eol + ".md",
      file = join(work, name);
    const initial = ["# " + marker, "", "alpha", "beta", "gamma", ""].join(sep);
    writeFileSync(file, initial);
    const first = await open(name, marker);
    await focus(first, 4);
    await win.keyboard.press("Control+Backslash");
    await waitFor(
      async () => (await frames(marker)).length === 2,
      "Split did not create two panels",
    );
    const pair = await frames(marker);
    await focus(pair[0], 4);
    await win.keyboard.insertText("FIRST");
    await win.keyboard.press("Control+s");
    const afterFirst = initial.replace("beta", "betaFIRST");
    await waitFor(
      async () => readFileSync(file, "utf8") === afterFirst,
      "Immediate save dropped input",
    );
    await waitFor(
      async () => (await text(pair[1])) === afterFirst.replace(/\r\n/g, "\n"),
      "Second panel is stale",
    );
    await focus(pair[1], 5);
    await win.keyboard.insertText("SECOND");
    await win.keyboard.press("Control+s");
    const afterSecond = afterFirst.replace("gamma", "gammaSECOND");
    await waitFor(
      async () => readFileSync(file, "utf8") === afterSecond,
      "Second panel edited a stale offset",
    );
    await waitFor(
      async () => (await text(pair[0])) === afterSecond.replace(/\r\n/g, "\n"),
      "First panel did not reconcile",
    );
    // Both frames produce a burst before they can receive each other's changes.
    await Promise.all(
      pair.map((f, index) =>
        f.evaluate((index) => {
          const v = document.querySelector(".cm-content").cmTile.root.view;
          for (let i = 0; i < 50; i++) {
            v.dispatch({
              changes: { from: v.state.doc.length, insert: ` [${index}:${i}]` },
            });
          }
        }, index),
      ),
    );
    await waitFor(async () => {
      const a = await text(pair[0]),
        b = await text(pair[1]);
      return (
        a === b &&
        Array.from({ length: 2 }, (_, c) =>
          Array.from({ length: 50 }, (_, i) => `[${c}:${i}]`),
        )
          .flat()
          .every((t) => a.includes(t))
      );
    }, "Concurrent panels did not converge");
    await focus(pair[0]);
    await win.keyboard.press("Control+s");
    const expected = await text(pair[0]);
    await waitFor(
      async () =>
        readFileSync(file, "utf8").replace(/\r\n/g, "\n") === expected,
      "Concurrent save mismatch",
    );
    for (let c = 0; c < 2; c++)
      for (let i = 0; i < 50; i++)
        assert.equal(
          expected.split(`[${c}:${i}]`).length - 1,
          1,
          "Duplicate or lost update",
        );
    await Promise.all(
      pair.map((f) =>
        f.evaluate(() => {
          const v = document.querySelector(".cm-content").cmTile.root.view;
          v.scrollDOM.scrollTop = 0;
        }),
      ),
    );
    await win.screenshot({ path: join(output, eol + "-concurrent.png") });
    records.push({ eol, concurrentEdits: 100, status: "passed" });
    console.log(
      `  ✓ ${eol}: immediate save, both panels, 100 concurrent edits`,
    );
    await palette(win, "Control+Shift+P", ">View: Close All Editors");
    await win.waitForTimeout(500);
  }
  // Keep a preview alive while editing and changing EOLs through the source pane.
  const file = join(work, "host.md"),
    marker = "Host changes";
  writeFileSync(file, "# " + marker + "\r\n\r\nalpha\r\nbeta\r\n");
  const preview = await open("host.md", marker);
  await focus(preview, 4);
  await win.keyboard.press("Control+Backslash");
  await win.waitForTimeout(700);
  await win.locator('.editor-actions [aria-label*="Code View"]').last().click();
  const source = win.locator(".editor-group-container .monaco-editor .view-lines").last();
  await source.waitFor({ state: "visible" });
  await source.click();
  await win.keyboard.press("Control+End");
  assert.ok(
    await win.evaluate(() => !!document.activeElement?.closest(".editor-group-container .monaco-editor")),
    "Native source editor must own keyboard focus before insertion",
  );
  await win.keyboard.insertText("HOST");
  await win.keyboard.press("Control+s");
  await waitFor(
    async () => readFileSync(file, "utf8") === "# " + marker + "\r\n\r\nalpha\r\nbeta\r\nHOST",
    "Native source insertion was not saved to the test document",
  );
  await waitFor(
    async () => (await text(preview)).endsWith("HOST"),
    "Host insertion not delivered to preview",
  );
  // Invoke the native EOL picker, choose LF, then return focus to the live panel.
  await win.locator('[id="status.editor.eol"]').click();
  await win
    .locator(".quick-input-widget")
    .getByText("LF", { exact: true })
    .click();
  await source.click();
  await win.keyboard.press("Control+s");
  await waitFor(
    async () => !readFileSync(file, "utf8").includes("\r"),
    "EOL switch was not performed",
  );
  await focus(preview);
  await win.keyboard.insertText("AFTER_EOL");
  await win.keyboard.press("Control+s");
  await waitFor(
    async () => readFileSync(file, "utf8") === (await text(preview)),
    "Editing after EOL switch diverged",
  );
  await source.click();
  await win.locator('[id="status.editor.eol"]').click();
  await win
    .locator(".quick-input-widget")
    .getByText("CRLF", { exact: true })
    .click();
  await source.click();
  await win.keyboard.press("Control+s");
  await waitFor(
    async () => readFileSync(file, "utf8").includes("\r\n"),
    "LF to CRLF switch was not performed",
  );
  await focus(preview);
  await win.keyboard.insertText("BACK_TO_CRLF");
  await win.keyboard.press("Control+s");
  await waitFor(
    async () =>
      readFileSync(file, "utf8").replace(/\r\n/g, "\n") ===
      (await text(preview)),
    "Editing after LF to CRLF switch diverged",
  );
  records.push({
    scenario:
      "source updates and EOL switches in both directions with a live peer",
    status: "passed",
  });
  console.log("  ✓ source edits and EOL switch preserve the live peer");
  assert.equal(errors.length, 0, errors.join("\n"));
} finally {
  if (win)
    await win.screenshot({ path: join(output, "final.png") }).catch(() => {});
  writeFileSync(
    join(output, "results.json"),
    JSON.stringify({ work, records, errors }, null, 2),
  );
  await app.close();
}

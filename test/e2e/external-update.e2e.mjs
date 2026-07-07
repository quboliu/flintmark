import { _electron as electron } from "playwright";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert";
import { palette as openPalette } from "./quickInput.mjs";

const REPO = resolve(".");
const VSCODE = process.env.VSCODE_BIN || "/usr/share/codium/codium";

const realWork = mkdtempSync(join(tmpdir(), "ofm-external-update-real-"));
let work = realWork;
if (process.env.OFM_REPRO_SYMLINK === "1") {
  const linkParent = mkdtempSync(join(tmpdir(), "ofm-external-update-link-"));
  work = join(linkParent, "workspace-link");
  symlinkSync(realWork, work, "dir");
}
const userData = join(realWork, "user-data");
mkdirSync(join(userData, "User"), { recursive: true });
writeFileSync(
  join(userData, "User", "settings.json"),
  JSON.stringify({
    "workbench.editorAssociations": { "*.md": "ofm.livePreview" },
    "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none",
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "window.commandCenter": false,
    "ofm.ai.trigger": "manual",
  })
);

const notePath = join(realWork, "note.md");
const INITIAL = "# External update repro\n\nThis line is already visible.\n";
const ADDED = "Codex inserted this paragraph from outside VS Code.";
const normalizeEditorText = (text) => text.replace(/\u00a0/g, " ");
const foldsWhitespace = (text) => normalizeEditorText(text).replace(/\s+/g, " ").trim();
const containsEditorText = (haystack, needle) =>
  foldsWhitespace(haystack).includes(foldsWhitespace(needle));
writeFileSync(notePath, INITIAL);

const app = await electron.launch({
  executablePath: VSCODE,
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--user-data-dir=${userData}`,
    `--extensions-dir=${join(work, "ext")}`,
    `--extensionDevelopmentPath=${REPO}`,
    work,
  ],
});

try {
  const win = await app.firstWindow();
  await win.waitForSelector(".monaco-workbench", { timeout: 30000 });
  await win.waitForTimeout(4500);

  const palette = (combo, text) => openPalette(win, combo, text, { waitBeforeEnter: 1000 });
  async function clickEditorAction(label, waitAfterClick = 1500) {
    const action = win.locator(`.editor-actions [aria-label*="${label}"]`).first();
    await action.waitFor({ state: "visible", timeout: 8000 });
    await action.click();
    await win.waitForTimeout(waitAfterClick);
  }

  async function findCmFrame(ms, opts = {}) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      for (const f of win.frames()) {
        try {
          const content = f.locator(".cm-content").first();
          if ((await content.count()) > 0 && (!opts.visible || (await content.isVisible()))) {
            return f;
          }
        } catch {
          // Cross-origin frames are irrelevant here.
        }
      }
      await win.waitForTimeout(250);
    }
    return null;
  }

  await palette("Control+P", "note.md");
  const cm = await findCmFrame(10000, { visible: true });
  assert.ok(cm, "Live Preview CodeMirror editor should open");

  const before = await cm.locator(".cm-content").innerText();
  assert.ok(before.includes("This line is already visible."), before);

  writeFileSync(notePath, INITIAL + "\n" + ADDED + "\n");

  let liveText = "";
  const liveDeadline = Date.now() + 10000;
  while (Date.now() < liveDeadline) {
    liveText = await cm.locator(".cm-content").innerText();
    if (liveText.includes(ADDED)) break;
    await win.waitForTimeout(500);
  }

  const liveHasExternalUpdate = liveText.includes(ADDED);

  await clickEditorAction("Code View");
  await win.locator(".monaco-editor .view-lines").first().waitFor({ state: "visible", timeout: 8000 });
  const sourceText = normalizeEditorText(
    await win.locator(".monaco-editor .view-lines").first().innerText()
  );
  const diskText = readFileSync(notePath, "utf8");

  assert.ok(diskText.includes(ADDED), "external write should be on disk");
  assert.ok(containsEditorText(sourceText, ADDED), "source mode should show the external write");
  assert.ok(liveHasExternalUpdate, `Live Preview did not show the external write. Live text was:\n${liveText}`);

  const SOURCE_ADDED = "This paragraph was typed in the source editor.";
  await win.keyboard.press("End");
  await win.keyboard.press("Enter");
  await win.keyboard.press("Enter");
  await win.keyboard.type(SOURCE_ADDED);
  await win.waitForTimeout(1200);
  const sourceAfterTyping = normalizeEditorText(
    await win.locator(".monaco-editor .view-lines").first().innerText()
  );
  assert.ok(
    containsEditorText(sourceAfterTyping, SOURCE_ADDED),
    `source editor should show typed paragraph; got:\n${sourceAfterTyping}`
  );

  await clickEditorAction("Live View");
  let cmAfterSource = await findCmFrame(5000, { visible: true });
  assert.ok(cmAfterSource, "Live Preview should reopen after source edit");
  let liveAfterSource = "";
  const returnDeadline = Date.now() + 10000;
  while (Date.now() < returnDeadline) {
    liveAfterSource = await cmAfterSource.locator(".cm-content").innerText();
    if (containsEditorText(liveAfterSource, SOURCE_ADDED)) break;
    await win.waitForTimeout(500);
  }
  assert.ok(
    containsEditorText(liveAfterSource, SOURCE_ADDED),
    `Live Preview did not show the paragraph typed in source mode. Live text was:\n${liveAfterSource}`
  );

  const SPLIT_ADDED = "This paragraph was typed in a split source editor.";
  await clickEditorAction("Split Editor Right");
  await clickEditorAction("Code View");
  await win.locator(".monaco-editor .view-lines").first().waitFor({ state: "visible", timeout: 8000 });
  await win.keyboard.press("Control+End");
  await win.keyboard.press("Enter");
  await win.keyboard.press("Enter");
  await win.keyboard.type(SPLIT_ADDED);
  await win.waitForTimeout(1200);
  const splitSourceText = normalizeEditorText(
    await win.locator(".monaco-editor .view-lines").first().innerText()
  );
  assert.ok(
    containsEditorText(splitSourceText, SPLIT_ADDED),
    `split source editor should show typed paragraph; got:\n${splitSourceText}`
  );

  let splitLiveText = "";
  const splitDeadline = Date.now() + 10000;
  while (Date.now() < splitDeadline) {
    const splitCm = await findCmFrame(1000, { visible: true });
    if (splitCm) {
      splitLiveText = await splitCm.locator(".cm-content").innerText();
      if (containsEditorText(splitLiveText, SPLIT_ADDED)) break;
    }
    await win.waitForTimeout(500);
  }
  assert.ok(
    containsEditorText(splitLiveText, SPLIT_ADDED),
    `Live Preview did not show the paragraph typed in a split source editor. Live text was:\n${splitLiveText}`
  );
} finally {
  await app.close();
}

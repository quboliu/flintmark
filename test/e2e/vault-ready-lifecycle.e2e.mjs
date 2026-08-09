// The webview must paint while a deliberately expensive initial Vault build is
// still running, then receive autocomplete data without rebuilding the editor.
import { _electron as electron } from "playwright";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert";

const REPO = resolve(".");
const VSCODE = process.env.VSCODE_BIN || "/usr/share/codium/codium";
const work = mkdtempSync(join(tmpdir(), "ofm-vault-ready-"));
const userData = join(work, "user-data");
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
  })
);

const openPath = join(work, "open.md");
writeFileSync(openPath, "# Ready lifecycle\n\nselection-probe\n");
writeFileSync(join(work, "Late Vault Target.md"), "# Late Vault Target\n");
const links = Array.from({ length: 120 }, (_, i) => `[[Synthetic-${i % 37}]]`).join(" ");
for (let i = 0; i < 10_000; i++) {
  writeFileSync(join(work, `Synthetic-${i}.md`), `# Synthetic ${i}\n\n#tag-${i % 41} ${links}\n`);
}

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
    openPath,
  ],
});

async function findCmFrame(win, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of win.frames()) {
      try {
        const content = frame.locator(".cm-content").first();
        if ((await content.count()) > 0 && (await content.isVisible())) return frame;
      } catch {
        /* cross-origin */
      }
    }
    await win.waitForTimeout(25);
  }
  return null;
}

async function autocompleteOptions(cm, win) {
  const line = cm.locator(".cm-line", { hasText: "selection-probe" }).first();
  await line.click();
  await win.keyboard.press("End");
  await win.keyboard.type(" [[Late");
  await win.waitForTimeout(250);
  return await cm.locator(".cm-tooltip-autocomplete li").allInnerTexts();
}

async function reopenWithFlintmark(win) {
  await win.bringToFront();
  await win.keyboard.press("Escape").catch(() => {});
  await win.keyboard.press("F1");
  const widget = win.locator(".quick-input-widget");
  await widget.waitFor({ state: "visible", timeout: 10000 });
  const input = widget.locator("input").first();
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.fill(">Reopen Editor With");
  const command = widget
    .locator(".monaco-list-row")
    .filter({ hasText: /Reopen Editor With/ })
    .first();
  await command.waitFor({ state: "visible", timeout: 30000 });
  await command.click();
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.fill("Flintmark");
  const choice = widget
    .locator(".monaco-list-row")
    .filter({ hasText: /Flintmark|Markdown Live Preview/ })
    .first();
  await choice.waitFor({ state: "visible", timeout: 30000 });
  await choice.click();
}

try {
  const win = await app.firstWindow();
  await win.waitForSelector(".monaco-workbench", { timeout: 30000 });
  let cm = await findCmFrame(win, 500);
  for (let attempt = 0; attempt < 3 && !cm; attempt++) {
    try {
      await reopenWithFlintmark(win);
      cm = await findCmFrame(win, 10000);
    } catch {
      await win.keyboard.press("Escape").catch(() => {});
    }
    if (!cm) await win.waitForTimeout(2500);
  }
  assert.ok(cm, "open.md should paint in Flintmark while the vault build runs");

  await cm.locator(".cm-editor").evaluate((el) => {
    el.dataset.vaultReadyInstance = "original";
  });
  // Establish the selection before VaultData arrives. On a fast build the
  // initial autocomplete may already be populated, so that intermediate state
  // is deliberately not part of the lifecycle contract.
  await autocompleteOptions(cm, win);

  await win.keyboard.press("Escape");
  for (let i = 0; i < 7; i++) await win.keyboard.press("Backspace");

  let eventualOptions = [];
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    eventualOptions = await autocompleteOptions(cm, win);
    if (eventualOptions.some((text) => text.includes("Late Vault Target"))) break;
    await win.keyboard.press("Escape");
    for (let i = 0; i < 7; i++) await win.keyboard.press("Backspace");
    await win.waitForTimeout(400);
  }

  assert.ok(
    eventualOptions.some((text) => text.includes("Late Vault Target")),
    `published VaultData should eventually reach the existing editor: ${JSON.stringify(eventualOptions)}`
  );
  const state = await cm.evaluate(() => ({
    token: document.querySelector(".cm-editor")?.dataset.vaultReadyInstance,
    activeText: (() => {
      let node = window.getSelection()?.focusNode ?? null;
      while (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentNode;
      return node?.closest?.(".cm-line")?.textContent ?? "";
    })(),
    editorCount: document.querySelectorAll(".cm-editor").length,
  }));
  assert.equal(state.token, "original", "VaultData push must not rebuild the EditorView DOM");
  assert.equal(state.editorCount, 1, "only one editor instance should remain");
  assert.ok(state.activeText.includes("selection-probe"), "the active selection line must be retained");
  console.log("  ✓ body paints before VaultData; later data preserves editor instance and selection");
} finally {
  await app.close().catch(() => {});
}

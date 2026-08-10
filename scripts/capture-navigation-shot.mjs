// README screenshot generator for Flintmark's document-navigation sidebar.
// Run from the repo root:
//   npm run compile && xvfb-run -a node scripts/capture-navigation-shot.mjs
//
// Writes media/shots/navigation.png from the real extension running in VSCodium.
import { _electron as electron } from "playwright";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(".");
const VSCODE = process.env.VSCODE_BIN || "/usr/share/codium/codium";
const SHOTS = join(REPO, "media", "shots");
const work = mkdtempSync(join(tmpdir(), "flintmark-navigation-"));
const userData = join(work, "user-data");

mkdirSync(join(userData, "User"), { recursive: true });
mkdirSync(SHOTS, { recursive: true });
writeFileSync(
  join(userData, "User", "settings.json"),
  JSON.stringify(
    {
      "workbench.editorAssociations": {
        "*.md": "ofm.livePreview",
        "*.markdown": "ofm.livePreview",
      },
      "workbench.colorTheme": "Default Dark Modern",
      "security.workspace.trust.enabled": false,
      "workbench.startupEditor": "none",
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "window.commandCenter": false,
      "ofm.ai.trigger": "manual",
      "editor.fontSize": 14,
      "window.zoomLevel": 0,
    },
    null,
    2
  )
);

writeFileSync(
  join(work, "Project Notes.md"),
  [
    "---",
    "status: active",
    "tags: [flintmark, release]",
    "---",
    "",
    "# Project Notes",
    "",
    "> [!tip] Stay in the document",
    "> Outline, Todo, and Backlinks remain visible beside Live Preview.",
    "",
    "## Release checklist",
    "",
    "- [x] Stabilize long-note scrolling",
    "- [/] Refresh the feature tour",
    "- [ ] Publish the next release",
    "",
    "## Architecture",
    "",
    "Markdown stays the source of truth; the preview is only a view.",
    "",
    "### Vault index",
    "",
    "Wikilinks, tags, images, and backlinks update with the workspace.",
    "",
  ].join("\n")
);
writeFileSync(
  join(work, "Roadmap.md"),
  "# Roadmap\n\nThe current milestone is tracked in [[Project Notes]].\n"
);
writeFileSync(
  join(work, "Release Notes.md"),
  "# Release Notes\n\nSee [[Project Notes#Release checklist]] before publishing.\n"
);

async function palette(win, combo, query) {
  const widget = win.locator(".quick-input-widget");
  for (let attempt = 0; ; attempt++) {
    await win.keyboard.press(combo);
    try {
      await widget.waitFor({ state: "visible", timeout: 5000 });
      break;
    } catch (error) {
      if (attempt >= 3) throw error;
      await win.waitForTimeout(1000);
    }
  }
  await win.waitForTimeout(400);
  await win.keyboard.type(query);
  await win.waitForTimeout(1000);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(1300);
}

async function findCmFrame(win, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of win.frames()) {
      try {
        if ((await frame.locator(".cm-content").count()) > 0) return frame;
      } catch {
        // Cross-origin workbench frames can disappear while the editor opens.
      }
    }
    await win.waitForTimeout(500);
  }
  return null;
}

async function openLivePreview(win) {
  await palette(win, "Control+P", "Project Notes.md");
  let cm = await findCmFrame(win, 5000);
  if (cm) return cm;

  await palette(win, "Control+Shift+P", "Reopen Editor With");
  await win.keyboard.type("Flintmark Live Preview");
  await win.waitForTimeout(900);
  await win.keyboard.press("Enter");
  cm = await findCmFrame(win, 8000);
  return cm;
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
  ],
});

try {
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1360, height: 900 });
  await win.waitForSelector(".monaco-workbench", { timeout: 30000 });
  await win.waitForTimeout(4500);

  const cm = await openLivePreview(win);
  if (!cm) throw new Error("Flintmark CM6 editor never appeared");
  await cm.locator(".cm-line").last().click();

  const flintmark = win.locator('.activitybar a[aria-label*="Flintmark"]').first();
  await flintmark.waitFor({ state: "visible", timeout: 8000 });
  await flintmark.click();

  const outline = win.locator(".pane").filter({ hasText: /^\s*Outline/i }).first();
  const todo = win.locator(".pane").filter({ hasText: /^\s*Todo/i }).first();
  const backlinks = win.locator(".pane").filter({ hasText: /^\s*Backlinks/i }).first();
  await outline.waitFor({ state: "visible", timeout: 8000 });
  await todo.waitFor({ state: "visible", timeout: 8000 });
  await backlinks.waitFor({ state: "visible", timeout: 8000 });

  await palette(win, "Control+Shift+P", "Refresh Backlinks");
  await backlinks
    .locator(".monaco-list-row", { hasText: "Roadmap" })
    .first()
    .waitFor({ state: "visible", timeout: 8000 });
  await todo
    .locator(".monaco-list-row", { hasText: "Refresh the feature tour" })
    .first()
    .waitFor({ state: "visible", timeout: 8000 });
  await outline
    .locator(".monaco-list-row", { hasText: "Release checklist" })
    .first()
    .waitFor({ state: "visible", timeout: 8000 });
  await win.waitForTimeout(700);

  await win.screenshot({ path: join(SHOTS, "navigation.png") });
  console.log("wrote media/shots/navigation.png");
} finally {
  await app.close();
}

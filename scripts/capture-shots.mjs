// README screenshot capture for editing, autocomplete, and the AI bridge.
// Run from the repo root: xvfb-run -a node scripts/capture-shots.mjs
// Writes editing.png, autocomplete.png, and ai.png into media/shots/.
import { _electron as electron } from "playwright";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(".");
const VSCODE = process.env.VSCODE_BIN || "/usr/share/codium/codium";
const work = mkdtempSync(join(tmpdir(), "ofm-shot-"));
const userData = join(work, "user-data");
mkdirSync(join(userData, "User"), { recursive: true });
writeFileSync(
  join(userData, "User", "settings.json"),
  JSON.stringify({
    "workbench.editorAssociations": { "*.md": "ofm.livePreview" },
    "workbench.colorTheme": "Default Dark Modern",
    "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none",
    "editor.fontSize": 15,
    "window.zoomLevel": 0.6,
  })
);
writeFileSync(join(work, "Roadmap.md"), "# Roadmap\n");
writeFileSync(join(work, "Backlog.md"), "# Backlog\n");
const note = join(work, "Project Notes.md");
writeFileSync(
  note,
  [
    "# Project Notes",
    "",
    "## Tasks",
    "",
    "- [ ] draft the spec",
    "- [/] wire the editor",
    "- [x] ship live preview",
    "- [-] rewrite parser",
    "- [>] follow up next week",
    "",
    "## Snippet",
    "",
    "```js",
    "function greet(name) {",
    "  return `Hello, ${name}!`;",
    "}",
    "```",
    "",
    "Linked to [[Roadmap]] and tagged #project.",
    "",
  ].join("\n")
);
writeFileSync(
  join(work, "AI Bridge.md"),
  [
    "# Use your editor's AI",
    "",
    "Select any text to use it with Copilot or Cursor.",
    "",
  ].join("\n")
);

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

const win = await app.firstWindow();
await win.waitForSelector(".monaco-workbench", { timeout: 30000 });
await win.setViewportSize({ width: 1100, height: 760 });
await win.waitForTimeout(4000);

async function palette(combo, text) {
  await win.keyboard.press(combo);
  await win.waitForTimeout(500);
  await win.keyboard.type(text);
  await win.waitForTimeout(900);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(1500);
}
async function frame() {
  for (let i = 0; i < 30; i++) {
    for (const f of win.frames()) {
      try {
        if ((await f.locator(".cm-content").count()) > 0) return f;
      } catch {
        /* cross-origin */
      }
    }
    await win.waitForTimeout(500);
  }
  return null;
}
async function frameContaining(text) {
  for (let i = 0; i < 30; i++) {
    for (const f of win.frames()) {
      try {
        if ((await f.locator(".cm-line").filter({ hasText: text }).count()) > 0) return f;
      } catch {
        /* cross-origin */
      }
    }
    await win.waitForTimeout(500);
  }
  return null;
}

await palette("Control+P", "Project Notes.md");
if (!(await frame())) {
  await palette("Control+Shift+P", "Reopen Editor With");
  await win.keyboard.type("Markdown Live Preview");
  await win.waitForTimeout(700);
  await win.keyboard.press("Enter");
}
const cm = await frame();
if (!cm) throw new Error("editor frame not found");
// Collapse the activity bar / side bar for a cleaner shot.
await win.keyboard.press("Control+b").catch(() => {});
await win.waitForTimeout(800);

// Shot 1: rendered note — extended task states, code Copy button, fold gutter.
await cm.locator(".cm-line").filter({ hasText: "Linked to" }).first().click();
await win.waitForTimeout(900);
await win.screenshot({ path: join(REPO, "media", "shots", "editing.png") });

// Shot 2: [[ autocomplete popup — placed high in the doc so the popup has room
// below and shows several vault notes.
await cm.locator(".cm-line").filter({ hasText: "Tasks" }).first().click();
await win.keyboard.press("End");
await win.keyboard.press("Enter");
await win.keyboard.type("Related: [[", { delay: 60 });
await win.waitForTimeout(1300);
await win.screenshot({ path: join(REPO, "media", "shots", "autocomplete.png") });

// Shot 3: current selection toolbar. Assert the exact UI before capturing so a
// future toolbar change cannot silently leave README artwork behind again.
await win.keyboard.press("Escape");
await palette("Control+P", "AI Bridge.md");
const aiCm = await frameContaining("Select any text");
if (!aiCm) throw new Error("AI Bridge editor frame not found");
const aiLine = aiCm.locator(".cm-line").filter({ hasText: "Select any text" }).first();
await aiLine.click();
await win.keyboard.press("Home");
await win.keyboard.press("Control+Shift+ArrowRight");
await win.keyboard.press("Control+Shift+ArrowRight");
await win.keyboard.press("Control+Shift+ArrowRight");
await win.waitForTimeout(500);

const toolbar = aiCm.locator(".ofm-ai-toolbar").first();
await toolbar.waitFor({ state: "visible", timeout: 4000 });
const labels = await toolbar.locator(".ofm-ai-button").allInnerTexts();
if (JSON.stringify(labels) !== JSON.stringify(["Edit", "Add to Chat"])) {
  throw new Error(`unexpected AI toolbar labels: ${JSON.stringify(labels)}`);
}
const hasExtraButtonContent = await toolbar.locator(".ofm-ai-button").evaluateAll((buttons) =>
  buttons.some((button) => button.childElementCount > 0)
);
if (hasExtraButtonContent) {
  throw new Error("AI toolbar buttons contain unexpected icon/markup children");
}

const aiBox = await aiLine.boundingBox();
if (!aiBox) throw new Error("AI selection line has no bounding box");
const aiClip = {
  x: Math.max(0, aiBox.x - 24),
  y: Math.max(0, aiBox.y - 68),
  width: Math.min(720, 1100 - Math.max(0, aiBox.x - 24)),
  height: Math.min(160, 760 - Math.max(0, aiBox.y - 68)),
};
await win.screenshot({ path: join(REPO, "media", "shots", "ai.png"), clip: aiClip });

await app.close();
console.log("captured media/shots/editing.png + autocomplete.png + ai.png");

// One-off marketing screenshot capture for the new Tier-1/Tier-2 features.
// Run from the repo root: xvfb-run -a node scripts/capture-shots.mjs
// Writes PNGs into media/shots/.
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

await app.close();
console.log("captured media/shots/editing.png + autocomplete.png");

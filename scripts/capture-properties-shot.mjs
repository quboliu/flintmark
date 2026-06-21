// One-off marketing screenshot for the frontmatter Properties panel.
// Run from the repo root: xvfb-run -a node scripts/capture-properties-shot.mjs
// Writes media/shots/properties.png.
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
const note = join(work, "epoll source walk.md");
writeFileSync(
  note,
  [
    "---",
    "title: epoll source walk",
    "created: 2026-06-21",
    "status: verified",
    "source_coverage:",
    "  - cov-0079",
    "  - cov-0151",
    "domain:",
    "  - Tech/OS-and-Linux",
    "tags:",
    "  - epoll",
    "  - linux",
    "---",
    "",
    "# epoll source walk",
    "",
    "The main path through the kernel's event loop, annotated.",
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

await palette("Control+P", "epoll source walk.md");
if (!(await frame())) {
  await palette("Control+Shift+P", "Reopen Editor With");
  await win.keyboard.type("Markdown Live Preview");
  await win.waitForTimeout(700);
  await win.keyboard.press("Enter");
}
const cm = await frame();
if (!cm) throw new Error("editor frame not found");
// Collapse the side bar for a cleaner shot; move the cursor into the body so no
// row is in edit state.
await win.keyboard.press("Control+b").catch(() => {});
await win.waitForTimeout(600);
await cm.locator(".ofm-properties").first().waitFor({ state: "visible", timeout: 8000 });
await cm.locator(".cm-line").filter({ hasText: "annotated" }).first().click();
await win.waitForTimeout(700);

const box = await win.locator(".part.editor").first().boundingBox();
await win.screenshot({
  path: join(REPO, "media", "shots", "properties.png"),
  clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 360) },
});

await app.close();
console.log("captured media/shots/properties.png");

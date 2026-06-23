// README screenshot generator for the Go pipelines demo note.
// Run from the repo root:
//   npm run compile && xvfb-run -a node scripts/capture-go-pipelines-shots.mjs
//
// Writes:
//   media/shots/go-pipelines-dark.png
//   media/shots/go-pipelines-light.png
import { _electron as electron } from "playwright";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(".");
const VSCODE = process.env.VSCODE_BIN || "/usr/share/codium/codium";
const DEMO = join(REPO, "media", "demo", "go-pipelines.md");
const SHOTS = join(REPO, "media", "shots");

const THEMES = [
  {
    name: "dark",
    workbenchTheme: "Default Dark Modern",
    output: "go-pipelines-dark.png",
  },
  {
    name: "light",
    workbenchTheme: "Default Light Modern",
    output: "go-pipelines-light.png",
  },
];

async function palette(win, combo, text) {
  const widget = win.locator(".quick-input-widget");
  for (let attempt = 0; ; attempt++) {
    await win.keyboard.press(combo);
    try {
      await widget.waitFor({ state: "visible", timeout: 5000 });
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await win.waitForTimeout(1000);
    }
  }
  await win.waitForTimeout(400);
  await win.keyboard.type(text);
  await win.waitForTimeout(1200);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(1500);
}

async function findCmFrame(win, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
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

async function openLivePreview(win) {
  await palette(win, "Control+P", "go-pipelines.md");
  let cm = await findCmFrame(win, 5000);
  if (cm) return cm;

  await palette(win, "Control+Shift+P", "Reopen Editor With");
  await win.keyboard.type("Flintmark Live Preview");
  await win.waitForTimeout(900);
  await win.keyboard.press("Enter");
  cm = await findCmFrame(win, 8000);
  if (cm) return cm;

  await palette(win, "Control+Shift+P", "Reopen Editor With");
  await win.keyboard.type("Markdown Live Preview");
  await win.waitForTimeout(900);
  await win.keyboard.press("Enter");
  return findCmFrame(win, 8000);
}

async function captureTheme(theme) {
  const work = mkdtempSync(join(tmpdir(), `flintmark-go-${theme.name}-`));
  const userData = join(work, "user-data");
  mkdirSync(join(userData, "User"), { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  copyFileSync(DEMO, join(work, "go-pipelines.md"));
  writeFileSync(join(work, "Concurrency Notes.md"), "# Concurrency Notes\n");
  writeFileSync(
    join(userData, "User", "settings.json"),
    JSON.stringify(
      {
        "workbench.editorAssociations": {
          "*.md": "ofm.livePreview",
          "*.markdown": "ofm.livePreview",
        },
        "workbench.colorTheme": theme.workbenchTheme,
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
    await win.setViewportSize({ width: 1320, height: 900 });
    await win.waitForSelector(".monaco-workbench", { timeout: 30000 });
    await win.waitForTimeout(4500);

    const cm = await openLivePreview(win);
    if (!cm) throw new Error("Flintmark CM6 editor never appeared");

    await win.keyboard.press("Control+b").catch(() => {});
    await cm.locator(".ofm-properties").first().waitFor({ state: "visible", timeout: 8000 });
    await cm.locator(".ofm-table").first().waitFor({ state: "visible", timeout: 8000 });
    await cm.locator(".cm-content").first().evaluate((el) => {
      el.scrollTop = 0;
    });
    await win.waitForTimeout(500);

    const box = await win.locator(".part.editor").first().boundingBox();
    if (!box) throw new Error("editor part has no bounding box");
    await win.screenshot({
      path: join(SHOTS, theme.output),
      clip: {
        x: box.x,
        y: box.y,
        width: box.width,
        height: Math.min(box.height, 840),
      },
    });
    console.log(`wrote media/shots/${theme.output}`);
  } finally {
    await app.close();
  }
}

for (const theme of THEMES) {
  await captureTheme(theme);
}

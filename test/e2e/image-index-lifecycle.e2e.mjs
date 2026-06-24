// Regression coverage for workspace index lifecycle edge cases that VS Code
// file watchers do not report as complete per-file logs: parent directory
// renames and externally-created nested resource trees.
import { _electron as electron } from "playwright";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert";

const REPO = resolve(".");
const VSCODE = process.env.VSCODE_BIN || "/usr/share/codium/codium";
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const work = mkdtempSync(join(tmpdir(), "ofm-image-index-"));
const userData = join(work, "user-data");
mkdirSync(join(userData, "User"), { recursive: true });
writeFileSync(
  join(userData, "User", "settings.json"),
  JSON.stringify({
    "workbench.editorAssociations": { "*.md": "ofm.livePreview" },
    "ofm.ai.trigger": "manual",
    "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none",
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "window.commandCenter": false,
  })
);

mkdirSync(join(work, "rename", "A", "assets"), { recursive: true });
writeFileSync(join(work, "rename", "A", "assets", "pixel.png"), PIXEL_PNG);
writeFileSync(
  join(work, "rename", "A", "note.md"),
  "# Rename image lifecycle\n\n![pixel](assets/pixel.png)\n\nend\n"
);
writeFileSync(
  join(work, "dynamic.md"),
  "# Dynamic image lifecycle\n\n![[dynamic-pixel.png]]\n\nend\n"
);

async function launchApp() {
  return await electron.launch({
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
}

let app = await launchApp();

async function closeApp(target = app) {
  let closed = false;
  await Promise.race([
    target.close().then(() => {
      closed = true;
    }),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (!closed) target.process()?.kill("SIGTERM");
}

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
  await win.waitForTimeout(1600);
}

async function findVisibleCmFrame(win, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const f of win.frames()) {
      try {
        const content = f.locator(".cm-content").first();
        if ((await content.count()) > 0 && (await content.isVisible())) return f;
      } catch {
        /* cross-origin */
      }
    }
    await win.waitForTimeout(250);
  }
  return null;
}

async function openLiveNote(win, spec) {
  await palette(win, "Control+P", spec);
  let cm = await findVisibleCmFrame(win, 8000);
  if (!cm) {
    await palette(win, "Control+Shift+P", "Reopen Editor With");
    await win.keyboard.type("Markdown Live Preview");
    await win.waitForTimeout(900);
    await win.keyboard.press("Enter");
    cm = await findVisibleCmFrame(win, 10000);
  }
  assert.ok(cm, `Live Preview should open ${spec}`);
  for (const f of win.frames()) {
    try {
      const content = f.locator(".cm-content").first();
      if ((await content.count()) > 0 && (await content.isVisible())) {
        await f.locator(".cm-line").last().click();
      }
    } catch {
      /* cross-origin */
    }
  }
  return cm;
}

async function imageState(frame) {
  return await frame.evaluate(() => {
    const img = document.querySelector("img.ofm-image");
    return img
      ? {
          src: img.getAttribute("src") || "",
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
        }
      : { missing: true };
  });
}

async function waitForLoadedImage(win, pathFragment) {
  let state;
  for (let i = 0; i < 40; i++) {
    for (const f of win.frames()) {
      try {
        if ((await f.locator(".cm-content").count()) === 0) continue;
        state = await imageState(f);
        if (
          !state.missing &&
          state.src.includes(pathFragment) &&
          state.naturalWidth > 0
        ) {
          return state;
        }
      } catch {
        /* cross-origin */
      }
    }
    await win.waitForTimeout(500);
  }
  throw new Error(
    `image did not load from ${pathFragment}; last state: ${JSON.stringify(state)}`
  );
}

let passed = false;

try {
  const win = await app.firstWindow();
  await win.waitForSelector(".monaco-workbench", { timeout: 30000 });
  await win.waitForTimeout(4500);

  await openLiveNote(win, "rename/A/note.md");
  await waitForLoadedImage(win, "/rename/A/assets/pixel.png");

  renameSync(join(work, "rename", "A"), join(work, "rename", "B"));
  await win.waitForTimeout(1500);

  await openLiveNote(win, "rename/B/note.md");
  await waitForLoadedImage(win, "/rename/B/assets/pixel.png");
  console.log("  ✓ image index refreshes after parent directory rename");

  await closeApp(app);
  app = await launchApp();
  const win2 = await app.firstWindow();
  await win2.waitForSelector(".monaco-workbench", { timeout: 30000 });
  await win2.waitForTimeout(4500);

  await openLiveNote(win2, "dynamic.md");
  mkdirSync(join(work, "dynamic", "assets"), { recursive: true });
  writeFileSync(join(work, "dynamic", "assets", "dynamic-pixel.png"), PIXEL_PNG);
  await waitForLoadedImage(win2, "/dynamic/assets/dynamic-pixel.png");
  console.log("  ✓ image index refreshes for externally-created nested trees");
  passed = true;
} finally {
  await closeApp();
  if (passed) process.exit(0);
}

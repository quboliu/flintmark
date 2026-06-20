// One-off README screenshot generator for the "Images & attachments" feature.
// Opens a tiny vault (a note + an attachments/ folder, referenced by BARE name)
// in the real CM6 webview and captures the rendered content to media/shots/images.png.
// Run: npm run compile && xvfb-run -a node scripts/shot-images.mjs
import { _electron as electron } from "playwright";
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
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
    "ofm.ai.trigger": "manual",
    "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none",
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "window.commandCenter": false,
    "editor.fontSize": 15,
  })
);
// Attachment in a SUBFOLDER, referenced by BARE name (Obsidian vault layout).
mkdirSync(join(work, "attachments"), { recursive: true });
copyFileSync(join(REPO, "media", "icon.png"), join(work, "attachments", "flintmark.png"));
writeFileSync(
  join(work, "note.md"),
  "# Images & attachments\n\n" +
    "Obsidian-style embeds resolve **across your vault** — the file lives in\n" +
    "`attachments/`, referenced by a bare name:\n\n" +
    "![[flintmark.png|96]]\n\n" +
    "Standard Markdown images work too: `![alt](path)` and `![[name|WxH]]` sizing.\n"
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
  await win.waitForSelector(".monaco-workbench", { timeout: 30000 });
  await win.waitForTimeout(4500);

  async function palette(combo, text) {
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
  async function findCmFrame(ms) {
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

  let cm = null;
  for (let attempt = 0; attempt < 3 && !cm; attempt++) {
    await palette("Control+P", "note.md");
    cm = await findCmFrame(5000);
    if (cm) break;
    await palette("Control+Shift+P", "Reopen Editor With");
    await win.keyboard.type("Markdown Live Preview");
    await win.waitForTimeout(900);
    await win.keyboard.press("Enter");
    cm = await findCmFrame(8000);
  }
  if (!cm) throw new Error("CM6 editor never appeared");

  // Move the caret off the image line so it renders, then wait for the vault
  // index to resolve the embed and the <img> to actually decode.
  await cm.locator(".cm-line").last().click();
  let ok = false;
  for (let i = 0; i < 40; i++) {
    ok = await cm.evaluate(() => {
      const img = document.querySelector("img.ofm-image");
      return !!(img && img.getAttribute("src") && /flintmark\.png/.test(img.getAttribute("src")) && img.naturalWidth > 0);
    });
    if (ok) break;
    await win.waitForTimeout(500);
  }
  if (!ok) throw new Error("embedded image never resolved/decoded");
  await win.waitForTimeout(600);

  mkdirSync(join(REPO, "media", "shots"), { recursive: true });
  const content = cm.locator(".cm-content").first();
  await content.screenshot({ path: join(REPO, "media", "shots", "images.png") });
  console.log("wrote media/shots/images.png");
} finally {
  await app.close();
}

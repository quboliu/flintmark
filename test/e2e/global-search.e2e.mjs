import { _electron as electron } from "playwright";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert";
import { palette } from "./quickInput.mjs";

const REPO = resolve(".");
const VSCODE = process.env.VSCODE_BIN || "/usr/share/codium/codium";

const work = mkdtempSync(join(tmpdir(), "ofm-global-search-"));
const userData = join(work, "user-data");
mkdirSync(join(userData, "User"), { recursive: true });
writeFileSync(
  join(userData, "User", "settings.json"),
  JSON.stringify({
    "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none",
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "window.commandCenter": false,
    "ofm.ai.trigger": "manual",
  })
);
writeFileSync(
  join(work, "note.md"),
  [
    "# Search Fixture",
    "",
    "top line",
    "",
    ...Array.from({ length: 80 }, (_, i) => `filler ${i}`),
    "",
    "formatword exact global search target",
    "",
    "bottom line",
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

try {
  const win = await app.firstWindow();
  await win.waitForSelector(".monaco-workbench", { timeout: 30000 });
  await win.waitForTimeout(4500);

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
      await win.waitForTimeout(250);
    }
    return null;
  }

  await palette(win, "Control+P", "note.md");
  let cm = await findCmFrame(3000);
  if (!cm) {
    await win.locator('.editor-actions [aria-label*="Live View"]').first().click();
    await win.waitForTimeout(1500);
    cm = await findCmFrame(10000);
  }
  assert.ok(cm, "Live Preview should open");

  await win.keyboard.press("Control+Shift+f");
  await win.waitForTimeout(500);
  await win.keyboard.type("formatword");
  await win.keyboard.press("Enter");
  await win.waitForTimeout(2500);

  const rows = win.locator(".search-view .monaco-list-row", { hasText: "formatword" });
  await rows.first().waitFor({ state: "visible", timeout: 10000 });
  await rows.first().click();
  await win.waitForTimeout(3000);

  let highlighted = false;
  for (const f of win.frames()) {
    try {
      const hit = f.locator(".ofm-external-search-hit", { hasText: "formatword" }).first();
      if ((await hit.count()) > 0 && (await hit.isVisible())) highlighted = true;
    } catch {
      /* cross-origin */
    }
  }
  if (!highlighted) {
    const state = {
      sourceEditors: await win.locator(".monaco-editor .view-lines").count(),
      tabs: await win.locator(".tab.active").allInnerTexts().catch(() => []),
      frames: [],
    };
    for (const f of win.frames()) {
      try {
        state.frames.push(
          await f.evaluate(() => ({
            url: location.href,
            cm: document.querySelectorAll(".cm-content").length,
            hit: document.querySelectorAll(".ofm-external-search-hit").length,
            hasFormatword: document.body.innerText.includes("formatword"),
            text: document.body.innerText.slice(0, 160),
          }))
        );
      } catch {
        /* cross-origin */
      }
    }
    assert.fail(
      `global Search result click should reveal and highlight in Live Preview; state=${JSON.stringify(state)}`
    );
  }
  console.log("  ✓ global Search result reveals and highlights in Live Preview");
} finally {
  await app.close().catch(() => {});
}

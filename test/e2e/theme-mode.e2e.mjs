import { _electron as electron } from "playwright";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert";

const REPO = resolve(".");
const VSCODE = process.env.VSCODE_BIN || "/usr/share/codium/codium";

const work = mkdtempSync(join(tmpdir(), "ofm-theme-mode-"));
const userData = join(work, "user-data");
const settingsPath = join(userData, "User", "settings.json");
mkdirSync(join(userData, "User"), { recursive: true });

const baseSettings = {
  "workbench.editorAssociations": { "*.md": "ofm.livePreview" },
  "workbench.colorTheme": "Default Dark Modern",
  "security.workspace.trust.enabled": false,
  "workbench.startupEditor": "none",
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "window.commandCenter": false,
  "ofm.ai.trigger": "manual",
  "editor.fontSize": 14,
};
writeSettings(baseSettings);

const notePath = join(work, "note.md");
writeFileSync(
  notePath,
  [
    "# Theme mode",
    "",
    ...Array.from({ length: 90 }, (_, i) =>
      `plain unformatted line ${String(i + 1).padStart(2, "0")}`
    ),
  ].join("\n") + "\n"
);

function writeSettings(settings) {
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function rgbNums(color) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  return m ? m.slice(1, 4).map(Number) : null;
}

function luminance(color) {
  const rgb = rgbNums(color);
  if (!rgb) return null;
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function hasClass(className, token) {
  return className.split(/\s+/).includes(token);
}

function assertNoBodyObsidianTheme(bodyClass) {
  assert.ok(
    !/(^|\s)theme-(dark|light)(\s|$)/.test(bodyClass),
    `VS Code-owned body should not be polluted with Obsidian theme classes; got ${bodyClass}`
  );
}

function assertDarkSurface(s, label) {
  assert.ok(hasClass(s.bodyClass, "vscode-dark") || hasClass(s.bodyClass, "vscode-high-contrast"), `${label}: body should be dark/high-contrast; got ${s.bodyClass}`);
  assertNoBodyObsidianTheme(s.bodyClass);
  assert.ok(hasClass(s.editorClass, "theme-dark"), `${label}: #editor should have theme-dark; got ${s.editorClass}`);
  assert.ok(!hasClass(s.editorClass, "theme-light"), `${label}: #editor should not have theme-light; got ${s.editorClass}`);
  assert.notEqual(s.caretColor, "rgb(0, 0, 0)", `${label}: dark caret should not be black`);
  assert.notEqual(s.gutterBg, "rgb(245, 245, 245)", `${label}: dark gutter should not be CM6's light default`);
  assert.ok((luminance(s.gutterBg) ?? 255) < 80, `${label}: gutter should be dark, got ${s.gutterBg}`);
}

function assertLightSurface(s, label) {
  assert.ok(hasClass(s.bodyClass, "vscode-light") || hasClass(s.bodyClass, "vscode-high-contrast-light"), `${label}: body should be light/high-contrast-light; got ${s.bodyClass}`);
  assertNoBodyObsidianTheme(s.bodyClass);
  assert.ok(hasClass(s.editorClass, "theme-light"), `${label}: #editor should have theme-light; got ${s.editorClass}`);
  assert.ok(!hasClass(s.editorClass, "theme-dark"), `${label}: #editor should not have theme-dark; got ${s.editorClass}`);
  assert.equal(s.editorBg, "rgb(255, 255, 255)", `${label}: editor background should be pure white, got ${s.editorBg}`);
  assert.equal(s.contentBg, "rgba(0, 0, 0, 0)", `${label}: content should stay transparent over the white editor, got ${s.contentBg}`);
  assert.ok((luminance(s.gutterBg) ?? 0) > 180, `${label}: gutter should be light, got ${s.gutterBg}`);
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
          // Cross-origin frames are irrelevant here.
        }
      }
      await win.waitForTimeout(250);
    }
    return null;
  }

  async function tryOpenLivePreview() {
    await palette("Control+P", "note.md");
    if (await findCmFrame(5000)) return true;

    await palette("Control+Shift+P", "Reopen Editor With");
    await win.keyboard.type("Markdown Live Preview");
    await win.waitForTimeout(900);
    await win.keyboard.press("Enter");
    return !!(await findCmFrame(8000));
  }

  async function snapshot(cm) {
    return cm.evaluate(() => {
      const editor = document.getElementById("editor");
      const cmEditor = document.querySelector(".cm-editor");
      const content = document.querySelector(".cm-content");
      const gutters = document.querySelector(".cm-gutters");
      const scroller = document.querySelector(".cm-scroller");
      const selection = getSelection();
      let node = selection?.focusNode;
      while (node && node.nodeType !== 1) node = node.parentElement;
      const focusLine = node?.closest?.(".cm-line");
      const style = (el) => getComputedStyle(el);
      return {
        bodyClass: document.body.className,
        editorClass: editor?.className ?? "",
        cmEditorClass: cmEditor?.className ?? "",
        cmEditorMark: cmEditor?.getAttribute("data-ofm-theme-test") ?? "",
        caretColor: content ? style(content).caretColor : "",
        contentBg: content ? style(content).backgroundColor : "",
        editorBg: cmEditor ? style(cmEditor).backgroundColor : "",
        gutterBg: gutters ? style(gutters).backgroundColor : "",
        scrollerTop: scroller ? scroller.scrollTop : 0,
        focusLineText: focusLine?.textContent ?? "",
      };
    });
  }

  async function waitFor(cm, predicate, label) {
    const deadline = Date.now() + 12000;
    let latest = await snapshot(cm);
    while (Date.now() < deadline) {
      if (predicate(latest)) return latest;
      await win.waitForTimeout(500);
      latest = await snapshot(cm);
    }
    assert.fail(`${label} did not happen; latest state: ${JSON.stringify(latest, null, 2)}`);
  }

  let cm = null;
  for (let attempt = 0; attempt < 3 && !cm; attempt++) {
    if (await tryOpenLivePreview()) {
      cm = await findCmFrame(2000);
      break;
    }
    await win.waitForTimeout(2500);
  }
  assert.ok(cm, "Live Preview CodeMirror editor should open");

  await cm.locator(".cm-scroller").first().evaluate((el) => {
    el.scrollTop = 900;
  });
  await win.waitForTimeout(600);
  const target = cm.locator(".cm-line").filter({ hasText: /plain unformatted line/ }).nth(5);
  const targetText = await target.innerText();
  await target.click({ position: { x: 120, y: 8 } });
  await win.waitForTimeout(300);
  await cm.evaluate(() => {
    document.querySelector(".cm-editor")?.setAttribute("data-ofm-theme-test", "same-editor");
  });

  const dark = await snapshot(cm);
  assertDarkSurface(dark, "initial dark");
  assert.ok(
    dark.focusLineText.includes(targetText),
    `initial selection should stay on the clicked line ${targetText}; got ${dark.focusLineText}`
  );
  assert.ok(dark.scrollerTop > 0, `test setup should be scrolled, got ${dark.scrollerTop}`);

  writeSettings({ ...baseSettings, "workbench.colorTheme": "Default Light Modern" });
  const light = await waitFor(
    cm,
    (s) => hasClass(s.bodyClass, "vscode-light") && hasClass(s.editorClass, "theme-light"),
    "switch to light theme"
  );
  assertNoBodyObsidianTheme(light.bodyClass);
  assertLightSurface(light, "light");
  assert.equal(light.cmEditorMark, "same-editor", "theme switching must not rebuild the CM6 editor DOM");
  assert.ok(
    light.focusLineText.includes(targetText),
    `selection should survive light theme switch; expected ${targetText}; got ${light.focusLineText}`
  );
  assert.ok(light.scrollerTop > 0, `scroll should not reset on light theme switch; got ${light.scrollerTop}`);
  assert.notEqual(light.gutterBg, dark.gutterBg, "gutter background should change with theme");

  writeSettings({ ...baseSettings, "workbench.colorTheme": "Default High Contrast" });
  const highContrast = await waitFor(
    cm,
    (s) => hasClass(s.bodyClass, "vscode-high-contrast") && hasClass(s.editorClass, "theme-dark"),
    "switch to high contrast theme"
  );
  assertDarkSurface(highContrast, "high contrast");
  assert.equal(highContrast.cmEditorMark, "same-editor", "high contrast switch must not rebuild the CM6 editor DOM");

  writeSettings({ ...baseSettings, "workbench.colorTheme": "Default High Contrast Light" });
  const highContrastLight = await waitFor(
    cm,
    (s) => hasClass(s.bodyClass, "vscode-high-contrast-light") && hasClass(s.editorClass, "theme-light"),
    "switch to high contrast light theme"
  );
  assertLightSurface(highContrastLight, "high contrast light");
  assert.equal(highContrastLight.cmEditorMark, "same-editor", "high contrast light switch must not rebuild the CM6 editor DOM");
} finally {
  await app.close();
}

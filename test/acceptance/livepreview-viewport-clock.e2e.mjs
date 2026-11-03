import { sourceLine, revealSource } from "./sourceViewport.mjs";
import { positiveWheel, verifyVisibleWheelDisplacement } from "./wheelCompletionClock.mjs";
import { installNativeAnchorTrace as installDetailedNativeAnchorTrace } from "./trace-native-anchor.mjs";
import {isVisibleFrame} from './visibleFrame.mjs';
const IS_CURSOR = /cursor/i.test(process.env.VSCODE_BIN||'');
// L3 end-to-end test (docs/05): drives the REAL CM6 webview inside VSCodium
// (headless under xvfb) and asserts the user-facing Live Preview behaviour that
// L1/L2 cannot reach — marker hiding, cursor-driven Reveal, and the typing →
// disk round-trip. Run via: xvfb-run -a node test/e2e/livepreview.e2e.mjs
import {createRequire} from 'node:module';const require=createRequire(process.env.FLINTMARK_DEPS+'/package.json');const{_electron:electron}=require('playwright');
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert";
import { palette as openPalette, reopenLivePreview } from "./quickInput.mjs";


// Timing runs must not add scrollTop reads inside CM's measure write phases.
// Preserve selection assertions while detailed diagnostic wrappers remain opt-in.
function installSelectionTrace(targetPos) {
  const view = document.querySelector('.cm-content')?.cmTile?.root?.view;
  if (!view) throw Error('Missing CodeMirror view');
  const start = performance.now();
  const events = [{kind:'trace-start', t:0, selection:view.state.selection.toJSON()}];
  window.__fmNativeAnchorTrace = {events, targetPos, finish(){
    events.push({kind:'trace-end', t:performance.now()-start, selection:view.state.selection.toJSON()});
    return {diagnosticOnly:true,instrumentation:'selection snapshots only; no measure wrappers',events};
  }};
}
const installNativeAnchorTrace = process.env.FLINTMARK_DETAILED_ANCHOR_TRACE === '1'
  ? installDetailedNativeAnchorTrace : installSelectionTrace;

// Mount a block widget without changing the source selection.
async function sourceWidget(frame, needle, selector) {
  await revealSource(frame, needle);
  const widget = frame.locator(selector).first();
  await widget.waitFor({ state: "attached", timeout: 10000 });
  await widget.scrollIntoViewIfNeeded();
  return widget;
}

const REPO = process.env.FLINTMARK_REPO || resolve(".");
const VSCODE = process.env.VSCODE_BIN || "/usr/share/codium/codium";

let failed = 0;
let total = 0;
const startedAt = Date.now();

let activeWin = null;
const TRIAGE_OUT = process.env.FLINTMARK_TRIAGE_OUT || join(REPO, "out", "functional-triage");
function bounded(promise, ms, fallback) {
  let timerId;
  const timer = new Promise((resolve) => {timerId=setTimeout(() => resolve(fallback), ms);});
  return Promise.race([Promise.resolve(promise).catch(() => fallback), timer]).finally(()=>clearTimeout(timerId));
}
async function captureCmState(frame, label) {
  if (!frame) return { label, missing: true };
  return bounded(frame.evaluate(() => {
    const content = document.querySelector(".cm-content");
    const view = content?.cmTile?.root?.view;
    const sel = view?.state?.selection?.main;
    let coords = null;
    try { coords = sel && view ? view.coordsAtPos(sel.from) : null; } catch { coords = "coords-error"; }
    const toolbar = document.querySelector(".ofm-ai-toolbar");
    const active = document.activeElement;
    return {
      active: active ? { tag: active.tagName, cls: String(active.className || ""), aria: active.getAttribute?.("aria-label"), html: (active.outerHTML || "").slice(0, 240) } : null,
      selection: sel ? { from: sel.from, to: sel.to, empty: sel.empty, text: view.state.sliceDoc(sel.from, sel.to).slice(0, 160) } : null,
      windowSelection: String(window.getSelection()?.toString() || "").slice(0, 160),
      coords,
      hasFocus:view?.hasFocus,
      doc: (view?.state?.doc?.toString() || "").slice(0, 400),
      docTail: (view?.state?.doc?.toString() || "").slice(-800),
      toolbar: toolbar ? { display: getComputedStyle(toolbar).display, rect: toolbar.getBoundingClientRect().toJSON() } : null,
    };
  }), 2500, { label, timeout: true });
}
async function captureTriage(label, extra = {}) {
  const win = activeWin;
  if (!win) return null;
  mkdirSync(TRIAGE_OUT, { recursive: true });
  const base = join(TRIAGE_OUT, String(label).replace(/[^a-z0-9._-]+/gi, "-").slice(0, 90) + "-" + Date.now());
  const data = { label, at: new Date().toISOString(), platform: process.platform, extra };
  data.active = await bounded(win.evaluate(() => {
    const a = document.activeElement;
    return a ? { tag: a.tagName, cls: String(a.className || ""), aria: a.getAttribute?.("aria-label"), html: (a.outerHTML || "").slice(0, 300) } : null;
  }), 1500, { timeout: true });
  data.tabs = await bounded(win.locator(".tab").allInnerTexts(), 1500, []);
  data.source = await bounded(win.locator(".monaco-editor .view-lines").allInnerTexts(), 1500, []);
  data.frames = [];
  for (const frame of win.frames().slice(0, 8)) {
    const frameState = await bounded((async () => {
      const content = frame.locator(".cm-content").first();
      if ((await content.count()) === 0) return null;
      return { visible: await content.isVisible(), text: (await content.innerText()).slice(0, 300), selection: await frame.evaluate(() => window.getSelection()?.toString() || "").catch(() => "") };
    })(), 1500, null);
    if (frameState) data.frames.push(frameState);
  }
  if (/FAIL|fail|hidden|missing|fallback/i.test(label)) {try { await bounded(win.screenshot({ path: base + ".png",timeout:4000 }), 4000, null); } catch {}}
  writeFileSync(base + ".json", JSON.stringify(data, null, 2));
  return { json: base + ".json", png: base + ".png", data };
}

async function test(name, fn) {
  total++;
  try {
    await fn();
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    const capture = await captureTriage("FAIL-" + name, { error: String(e.message || e) }).catch(() => null);
    console.error("  ✗ " + name + "\n      " + (e.message || e) + (capture ? "\n      evidence: " + capture.json : ""));
  }
}

// --- workspace fixture ---------------------------------------------------
const work = mkdtempSync(join(tmpdir(), "ofm-e2e-"));
const userData = mkdtempSync(join(tmpdir(), "fm-p-"));
const settingsPath = join(userData, "User", "settings.json");
mkdirSync(join(userData, "User"), { recursive: true });
const baseSettings = {
  "files.autoSave": "off",
  "workbench.editorAssociations": { "*.md": "ofm.livePreview" },
  "ofm.ai.trigger": "manual",
  "security.workspace.trust.enabled": false,
  "workbench.startupEditor": "none",
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
 "extensions.autoUpdate": false, "extensions.autoCheckUpdates": false,
  "window.commandCenter": false,
  // Pin a small editor font so the whole fixture fits the viewport and CM6
  // doesn't virtualize the bottom lines out of the DOM (these tests assert
  // behaviour, not pixel sizes). ofm.fontSize below overrides the body size.
  "editor.fontSize": 8,
  // Custom-font feature: prose font + size + code font, all INDEPENDENT of the
  // editor font. Generic families so layout barely shifts (and getComputedStyle
  // reports the specified list even when the named font isn't installed on CI).
  // Body stays proportional / code stays monospace, so the existing font test
  // still holds. fontSize 9 < editor+2 (10), so it only shrinks → no extra
  // virtualization risk.
  "ofm.fontFamily": "Georgia, serif",
  "ofm.fontSize": 9,
  "ofm.monospaceFontFamily": "'Courier New', monospace",
};
function writeSettings(settings) {
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
writeSettings(baseSettings);
const notePath = join(work, "note.md");
const INITIAL =
  "# Hello World\n\nThis is **bold** text.\n\n### Subheading (Things: blue)\n\n#### Sub-subheading (Things: yellow)\n\n> [!warning] Heads up\n> be careful\n\n- [ ] my task\n\n- apple\n- banana\n\n1. first\n2. second\n\nTags: #project ==important== [[Other Note]]\n\nEmbed note ![[Other Note]] and image ![[pixel.png]]\n\n![pixel](pixel.png)\n\nMath: $e=mc^2$\n\n$$\nQK^\\top\n\\quad\\longrightarrow\\quad\n\\frac{QK^\\top}{\\sqrt{d_h}}+M\n\\quad\\longrightarrow\\quad\n\\operatorname{softmax}\\!\\left(\\frac{QK^\\top}{\\sqrt{d_h}}+M\\right)\n$$\n\nmath-caret-alpha\n\n$$\n\\begin{aligned}\na &= b + c \\\\\nd &= \\frac{e}{f}\n\\end{aligned}\n$$\n\nmath-caret-beta\n\n| Feature | Status |\n| --- | --- |\n| **Tables** | `yes` |\n\n| Trail | Col |\n|-------|-----| \n| ok | done |\n\n```rust\nfn main() {\n    let x = 42;\n}\n```\n\n```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```\n\nA [real link](https://example.com) here.\n\n> plain quote\n> second\n\nSetext Two\n----------\n\n---\n\nplain line\n\n> [!important] Key\n> aliased callout type\n\nformatword\n\npasteword\n\n- [/] in progress task\n- [-] cancelled task\n\nzzz end\n";

// 1x1 transparent PNG, written into the workspace so the image can resolve.
const PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
writeFileSync(notePath, INITIAL);
writeFileSync(join(work, "pixel.png"), Buffer.from(PIXEL_PNG_B64, "base64"));
// Attachment in a SUBFOLDER, referenced by BARE name from a note elsewhere —
// the Obsidian vault layout the ImageIndex must resolve vault-wide.
mkdirSync(join(work, "attachments"), { recursive: true });
writeFileSync(join(work, "attachments", "deep.png"), Buffer.from(PIXEL_PNG_B64, "base64"));
// Target for the [[Other Note]] wikilink (resolved by the Vault Index).
writeFileSync(join(work, "Other Note.md"), "# Other Note\n\nlinked content\n");
// Dedicated fixture for callout-default-title + %% comment (kept OUT of the
// main note.md, whose line positions the click-offset test depends on).
writeFileSync(
  join(work, "features.md"),
  "---\ntitle: Features\ntags:\n  - demo\n  - test\n---\n\n# Features\n\n<div>\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"80\" height=\"40\" viewBox=\"0 0 80 40\" onload=\"window.__ofmSvgUnsafe = true\">\n  <script>window.__ofmSvgUnsafe = true</script>\n  <rect x=\"4\" y=\"4\" width=\"72\" height=\"32\" fill=\"red\" onclick=\"window.__ofmSvgUnsafe = true\" />\n  <text x=\"40\" y=\"25\" font-size=\"14\" text-anchor=\"middle\">SVG</text>\n</svg>\n</div>\n\n> [!note]\n> body only, no custom title\n\nVisible %%secretcomment%% visible.\n\nA claim[^1] needs a source.\n\n[^1]: the footnote definition.\n\n```sql\nSELECT id FROM users WHERE active = true;\n```\n\nVault image ![[deep.png]] from a subfolder.\n"
);
const LIVE_PREVIEW_DECORATION_CHAR_LIMIT = 300_000;
const longTable = (section) => [
  "| Topic | English detail | 中文说明 | Status |",
  "| :--- | --- | --- | ---: |",
  ...Array.from({ length: 18 }, (_, row) =>
    `| table-${section}-row-${row} | A deliberately long cell with varied words for realistic wrapping at narrow line widths, batch ${section}-${row}. | 第 ${section} 节第 ${row} 行包含用于窄栏换行测量的中英文混排内容。 | ${row % 3 === 0 ? "**ready**" : "pending"} |`
  ),
].join("\n");
const LONG_SCROLL = Array.from({ length: 420 }, (_, i) =>
  [
    `## Long Scroll Section ${i}`,
    "",
    "A paragraph with **bold** text, #tag, and [[Other Note]] so inline decorations exist.",
    "",
    "```c",
    "#include <stdio.h>",
    "int main(void) {",
    `    printf(\"section ${i}\\n\");`,
    "    return 0;",
    "}",
    "```",
    "",
    ...(i % 21 === 0 ? [longTable(i)] : []),
    "",
  ].join("\n")
).join("\n");
assert.ok(
  LONG_SCROLL.length < LIVE_PREVIEW_DECORATION_CHAR_LIMIT,
  `long-scroll fixture (${LONG_SCROLL.length}) must stay below decoration cutoff`
);
writeFileSync(join(work, "long-scroll.md"), LONG_SCROLL);
// Opened from the Explorer by the last test (single-click keeps focus there).
writeFileSync(join(work, "explorer-find.md"), "# Explorer Find\n\nexplorer-find body\n");

const app = await electron.launch({
  executablePath: VSCODE,
  args: [...(/cursor/i.test(process.env.VSCODE_BIN||'')?['--skip-onboarding']:[]),
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--user-data-dir=${userData}`,
    `--extensions-dir=${join(work, "ext")}`,
    `--extensionDevelopmentPath=${REPO}`,
    work,
    notePath,
  ],
});

try {
  const win = await app.firstWindow();activeWin = win;if(process.platform==='win32'||/cursor/i.test(process.env.VSCODE_BIN||"")){await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());if(w)w.setSize(1400,1000);});}await win.waitForSelector('.monaco-workbench',{timeout:120000});const welcome=win.locator('.antigravity-ide-welcome-button');if(await welcome.isVisible()){await welcome.click();await win.waitForTimeout(1500);}const originalPress=win.keyboard.press.bind(win.keyboard);win.keyboard.press=(key,options)=>{if(process.platform==='darwin'){key=key.replace('Control+Shift+BracketLeft','Meta+Alt+BracketLeft').replace('Control+Shift+BracketRight','Meta+Alt+BracketRight').replace('Control+Home','Meta+ArrowUp').replace('Control+End','Meta+ArrowDown').replace(/^Control\+/,'Meta+');if(key==='End')key='Meta+ArrowRight';if(key==='Home')key='Meta+ArrowLeft';}return originalPress(key,options);};
  const viewportWarnings = [];
  win.on("console", (msg) => {
    const text = msg.text();
    if (text.includes("Viewport failed to stabilize")) viewportWarnings.push(text);
  });
  await win.waitForSelector(".monaco-workbench", { timeout: 30000 });
  await win.waitForTimeout(4500); // let the workbench become interactive

  const palette = (combo, text) => openPalette(win, combo, text);
  async function findCmFrame(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      for (const f of win.frames()) {
        try {
          if ((await f.locator(".cm-content").count()) > 0 && await isVisibleFrame(f)) return f;
        } catch {
          /* cross-origin */
        }
      }
      await win.waitForTimeout(500);
    }
    return null;
  }
  // Open the Flintmark activity-bar container (holds Outline + Todo + Backlinks).
  // Idempotent: don't re-click if a panel is already visible (would hide it).
  async function openFlintmark() {
    if(IS_CURSOR){await palette("F1",">View: Show Flintmark");return;}
    // "Backlinks" is unique to our container (the native Explorer has its own
    // "OUTLINE" pane, so checking Outline would false-positive).
    const visible = await win
      .locator(".pane")
      .filter({ hasText: /Backlinks/i })
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) return;
    const icon = win.locator('.activitybar a[aria-label*="Flintmark"]').first();
    if (await icon.count()) {
      await icon.click();
      await win.waitForTimeout(900);
    }
  }

  // Open note.md in OUR editor. The dev extension's customEditor contribution
  // can take a moment to register, so retry: try association-open, then force
  // via "Reopen Editor With…", giving the extension time to load between tries.
  async function tryOpen() {
    await palette("Control+P", "note.md");
    if (await findCmFrame(5000)) return true;
    await reopenLivePreview(win);
    return !!(await findCmFrame(8000));
  }
  let cm = null;
  for (let attempt = 0; attempt < 3 && !cm; attempt++) {
    if (await tryOpen()) {
      cm = await findCmFrame(2000);
      break;
    }
    await win.waitForTimeout(2500); // let the extension finish loading, then retry
  }
  assert.ok(cm, "our CM6 editor (.cm-content) should be present");

  const headingText = async () => (await sourceLine(cm, "Hello World")).innerText();

  await test("our custom editor opened (not the native text editor)", async () => {
    const count = await cm.locator(".cm-content").count();
    assert.ok(count > 0, "expected a CM6 .cm-content");
  });

  // Runs before any test clicks into the text: like the built-in text editor,
  // a freshly opened Live Preview tab takes keys straight away.
  await test("Mod-F opens find right after opening, without a click", async () => {
    await win.waitForTimeout(500);
    await win.keyboard.press("Control+f");
    const panel = cm.locator(".cm-panel.cm-search");
    await panel.first().waitFor({ state: "visible", timeout: 4000 });
    await win.keyboard.press("Escape");
    await panel.first().waitFor({ state: "detached", timeout: 4000 });
  });

  await test("markers hidden when cursor is not in the construct", async () => {
    // Click a specific plain source line so the cursor is away from heading/bold.
    await (await sourceLine(cm, "plain line")).click();
    await win.waitForTimeout(400);
    const h = await headingText();
    assert.ok(h.includes("Hello World"), `heading text present, got: ${JSON.stringify(h)}`);
    assert.ok(!h.includes("#"), `heading '#' should be hidden, got: ${JSON.stringify(h)}`);
    const allText = await cm.locator(".cm-content").innerText();
    assert.ok(!allText.includes("**"), "bold '**' markers should be hidden");
  });

  await test("Reveal: cursor in the heading shows the '#' marker", async () => {
    await (await sourceLine(cm, "Hello World")).click(); // cursor enters the heading
    await win.waitForTimeout(500);
    const h = await headingText();
    assert.ok(h.includes("#"), `heading '#' should be revealed, got: ${JSON.stringify(h)}`);
  });

  await test("typing round-trips to disk (CM6 → TextDocument → save → file)", async () => {
    // Click the "plain line" line specifically (not the trailing empty line).
    await (await sourceLine(cm, "plain line")).click();
    await win.keyboard.press("End");
    await win.keyboard.type(" EDITED");
    await win.waitForTimeout(1200); // let the serialized edits reach the host
    const expected = Buffer.from(INITIAL.replace("\nplain line\n", "\nplain line EDITED\n"));
    const saveStarted = performance.now();
    const deadline = saveStarted + 10000;
    await win.keyboard.press("Control+S");
    await win.waitForTimeout(1500);
    let bytes = readFileSync(notePath);
    let readEnded = performance.now();
    const checkpoint = { elapsedMs: readEnded - saveStarted, exact: bytes.equals(expected) };
    // A keypress completion is not a disk-save completion. Keep the original
    // checkpoint visible, then wait for the complete expected file, with one save.
    while (!bytes.equals(expected) && performance.now() < deadline) {
      await win.waitForTimeout(Math.min(100, Math.max(0, deadline - performance.now())));
      bytes = readFileSync(notePath);
      readEnded = performance.now();
    }
    const withinBudget = bytes.equals(expected) && readEnded <= deadline;
    console.log("SINGLE_SAVE_COMPLETION", JSON.stringify({ checkpoint, completedMs: readEnded - saveStarted, budgetMs: 10000, exact: bytes.equals(expected), withinBudget }));
    assert.ok(withinBudget, `one save must persist the entire expected source within the bounded functional wait: ${JSON.stringify({ checkpoint, completedMs: readEnded - saveStarted, actualBytes: bytes.length, expectedBytes: expected.length, exact: bytes.equals(expected) })}`);
    const onDisk = bytes.toString("utf8");
    // The typed text must round-trip INTACT — this is the regression guard for
    // the concurrent-edit corruption that produced "ETD" from "EDITED" before
    // serialization. (Exact cursor line isn't the point.)
    assert.ok(
      onDisk.includes(" EDITED"),
      `typed text should round-trip intact (no corruption); file is:\n${onDisk}`
    );
    assert.ok(onDisk.startsWith("# Hello World"), "heading source preserved on disk");
    assert.ok(onDisk.includes("plain line"), "plain line preserved on disk");
    assert.ok(onDisk.includes("**bold**"), "bold source preserved on disk");
  });

  await test("Enter in a list continues the bullet marker", async () => {
    // Click into the "banana" list item, go to end, press Enter, type text.
    await (await sourceLine(cm, "banana")).click();
    await win.keyboard.press("End");
    await win.keyboard.press("Enter");
    await win.keyboard.type("cherry");
    await win.waitForTimeout(1000);
    await win.keyboard.press("Control+S");
    await win.waitForTimeout(1200);
    const onDisk = readFileSync(notePath, "utf8");
    // The key behaviour: the new line got an auto-inserted "- " marker (a plain
    // newline would have produced bare "cherry").
    assert.ok(
      /-\s+cherry/.test(onDisk) && onDisk.includes("- banana"),
      `Enter should continue the '- ' marker; file is:\n${onDisk}`
    );
  });

  await test("clicking a task checkbox toggles [ ]→[x] on disk", async () => {
    const box = (await sourceLine(cm, "my task")).locator("input.ofm-task-checkbox");
    await box.waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await box.isChecked(), false, "task should start unchecked");
    await box.click();
    await win.waitForTimeout(1000); // toggle round-trips through the host
    await win.keyboard.press("Control+S");
    await win.waitForTimeout(1500);
    const onDisk = readFileSync(notePath, "utf8");
    assert.ok(
      /- \[[xX]\] my task/.test(onDisk),
      `task should be checked on disk; file is:\n${onDisk}`
    );
  });

  await test("local image resolves to a webview URI and renders", async () => {
    const img = cm.locator("img.ofm-image").first();
    await img.waitFor({ state: "attached", timeout: 5000 });
    const src = await img.getAttribute("src");
    assert.ok(
      src && src.includes("pixel.png") && /^(https?:|vscode-webview:)/.test(src),
      `image src should be a resolved webview URI, got: ${src}`
    );
  });

  await test("inline math renders via KaTeX", async () => {
    await sourceLine(cm, "Math:", "Math:");
    await cm
      .locator(".ofm-math-inline .katex")
      .first()
      .waitFor({ state: "attached", timeout: 5000 });
    const n = await cm.locator(".ofm-math-inline .katex").count();
    assert.ok(n > 0, "KaTeX should render inside .ofm-math-inline");
  });

  await test("line-delimited target formula renders as error-free display math", async () => {
    await sourceWidget(cm, "\nQK^\\top\n", ".ofm-math-block");
    const display = cm.locator(".ofm-math-block .katex-display").first();
    await display.waitFor({ state: "attached", timeout: 5000 });
    assert.equal(
      await cm.locator(".ofm-math-block .katex-display").count(),
      2,
      "the target and tall regression formulas should each produce a display widget"
    );
    assert.equal(
      await cm.locator(".ofm-math-block .katex-error").count(),
      0,
      "KaTeX must accept the target formula without an error fallback"
    );
    assert.match(
      (await display.textContent()) ?? "",
      /softmax/,
      "the rendered display widget should contain the final softmax expression"
    );
  });

  await test("clicking below math blocks edits the geometrically clicked source line", async () => {
    const appendAtClickedLine = async (label, sentinel) => {
      const target = (await sourceLine(cm, label));
      await target.scrollIntoViewIfNeeded();
      await win.waitForTimeout(200);
      const box = await target.boundingBox();
      assert.ok(box, `${label} should have a measurable line box`);
      await cm.page().mouse.click(box.x + 20, box.y + box.height / 2);
      await win.waitForTimeout(250);
      const landed = await cm.evaluate(() => {
        const s = window.getSelection();
        let n = s && s.focusNode;
        while (n && n.nodeType !== 1) n = n.parentElement;
        const line = n ? n.closest(".cm-line") : null;
        return line ? (line.textContent || "").replace(/\n/g, "") : "(none)";
      });
      assert.ok(
        landed.includes(label),
        `caret must land on ${label}, got: ${JSON.stringify(landed)}`
      );
      await win.keyboard.press("End");
      await win.keyboard.type(sentinel);
      await win.waitForTimeout(300);
    };

    await appendAtClickedLine("math-caret-alpha", "__MATH_ALPHA__");
    await appendAtClickedLine("math-caret-beta", "__MATH_BETA__");
    await win.keyboard.press("Control+S");
    await win.waitForTimeout(1200);

    const lines = readFileSync(notePath, "utf8").split("\n");
    assert.ok(
      lines.includes("math-caret-alpha__MATH_ALPHA__"),
      "the first sentinel must be persisted only on the line clicked below the target formula"
    );
    assert.ok(
      lines.includes("math-caret-beta__MATH_BETA__"),
      "the second sentinel must be persisted only on the line clicked below the tall formula"
    );
    assert.equal(
      lines.filter((line) => line.includes("__MATH_ALPHA__")).length,
      1,
      "the first click must not mutate any neighbouring line"
    );
    assert.equal(
      lines.filter((line) => line.includes("__MATH_BETA__")).length,
      1,
      "the second click must not mutate any neighbouring line"
    );
  });

  await test("editing surface is .ml-root with Obsidian CSS variables defined", async () => {
    const root = cm.locator(".ml-root").first();
    await root.waitFor({ state: "attached", timeout: 5000 });
    const v = await root.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--text-normal").trim()
    );
    assert.ok(v.length > 0, `--text-normal should be defined on .ml-root, got: "${v}"`);
  });

  await test("code blocks get syntax highlighting (.cm-keyword tokens)", async () => {
    await sourceLine(cm, "fn main()");
    const kw = cm.locator(".cm-keyword");
    await kw.first().waitFor({ state: "attached", timeout: 6000 });
    assert.ok((await kw.count()) > 0, "expected highlighted .cm-keyword tokens in code");
    const color = await kw.first().evaluate((el) => getComputedStyle(el).color);
    const bodyColor = await cm.locator(".cm-content").first().evaluate((el) => getComputedStyle(el).color);
    assert.notEqual(color, bodyColor, `keyword token should be theme-colored, got ${color}`);
  });

  await test("rendered code blocks show a Copy button", async () => {
    // Cursor off the code block (in the heading) so it renders boxed with flair.
    await (await sourceLine(cm, "Hello World")).click();
    await win.waitForTimeout(400);
    await sourceLine(cm, "fn main()");
    const copy = cm.locator(".ofm-code-copy");
    await copy.first().waitFor({ state: "attached", timeout: 5000 });
    assert.ok((await copy.count()) > 0, "expected a .ofm-code-copy button on the rendered code block");
    // Clicking it must not throw (clipboard may be unavailable headless — we only
    // assert the wiring works and the button stays in the DOM).
    await copy.first().click();
    assert.ok((await copy.count()) > 0, "copy button remains after click");
  });

  await test("body text uses a proportional font, code stays monospace", async () => {
    await sourceLine(cm, "fn main()");
    // #2 theme alignment: body follows the theme's text font (sans); code/inline
    // set their own monospace. They must differ.
    const fonts = await cm.evaluate(() => {
      const ff = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).fontFamily : null;
      };
      return { body: ff(".cm-content"), code: ff(".cm-line.ofm-codeblock") };
    });
    assert.ok(fonts.body, "content font resolved");
    assert.ok(
      !/\bmonospace\b/i.test(fonts.body),
      `body font should be proportional, got ${fonts.body}`
    );
    assert.notEqual(fonts.body, fonts.code, "body and code fonts must differ");
  });

  await test("custom font settings override the theme + editor fonts", async () => {
    await sourceLine(cm, "fn main()");
    // ofm.fontFamily / fontSize / monospaceFontFamily (set in the fixture) must
    // win over the theme's text font AND the VS Code editor font, via the
    // --ofm-* override variables applied to the document root. getComputedStyle
    // returns the SPECIFIED family list, so this holds even when the named fonts
    // aren't installed on the CI runner.
    const r = await cm.evaluate(() => {
      const content = document.querySelector(".cm-content");
      const code = document.querySelector(".cm-line.ofm-codeblock");
      return {
        bodyFont: getComputedStyle(content).fontFamily,
        bodySize: getComputedStyle(content).fontSize,
        codeFont: code ? getComputedStyle(code).fontFamily : "",
        rootVar: getComputedStyle(document.documentElement)
          .getPropertyValue("--ofm-font-family")
          .trim(),
      };
    });
    assert.ok(
      /georgia/i.test(r.bodyFont),
      `body should use the custom prose font (ofm.fontFamily), got ${r.bodyFont}`
    );
    assert.ok(
      /courier/i.test(r.codeFont),
      `code should use the custom monospace font (ofm.monospaceFontFamily), got ${r.codeFont}`
    );
    assert.equal(
      r.bodySize,
      "9px",
      `body size should follow ofm.fontSize (9px), got ${r.bodySize}`
    );
    assert.ok(
      r.rootVar.length > 0,
      "--ofm-font-family should be set on the document root"
    );
  });

  await test("page layout applies a real side margin (not edge-to-edge)", async () => {
    // Regression guard: .cm-content padding MUST come from the CM6 theme layer so
    // it isn't overridden by CM6's base theme (which made the page edge-to-edge).
    // Default ofm.lineWidth = 0 → fill width + fixed 3.5rem (≈56px) side padding.
    const pad = await cm.evaluate(() => {
      const cs = getComputedStyle(document.querySelector(".cm-content"));
      return { left: parseFloat(cs.paddingLeft), right: parseFloat(cs.paddingRight) };
    });
    assert.ok(
      pad.left >= 48 && pad.right >= 48,
      `expected a real side margin (~56px), got left=${pad.left} right=${pad.right}`
    );
  });

  await test("headings use the theme's graduated sizes (h1 > h6 > 0)", async () => {
    await sourceLine(cm, "Hello World");
    const sizes = await cm.evaluate(() => {
      const px = (sel) => {
        const el = document.querySelector(sel);
        return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
      };
      return { h1: px(".ofm-heading-1"), h6: px(".ofm-heading-6, .cm-line.ofm-heading-6") };
    });
    assert.ok(sizes.h1 > 0, "h1 sized");
    // Sub-subheading (####) is h4; ensure h1 is clearly larger than a small heading.
    const small = await cm.evaluate(() => {
      const el = document.querySelector(".ofm-heading-4");
      return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
    });
    assert.ok(sizes.h1 > small && small > 0, `h1 (${sizes.h1}) should exceed h4 (${small})`);
  });

  await test("task checkbox renders as an Obsidian-style box (not native)", async () => {
    await sourceLine(cm, "my task");
    const box = await cm.evaluate(() => {
      const el = document.querySelector(".ofm-task-checkbox");
      if (!el) return null;
      const s = getComputedStyle(el);
      return { appearance: s.appearance || s.webkitAppearance, radius: s.borderRadius };
    });
    assert.ok(box, "a task checkbox exists");
    assert.equal(box.appearance, "none", "native appearance must be removed");
    assert.notEqual(box.radius, "0px", "Obsidian checkbox is rounded");
  });

  await test("revealed formatting marker is tagged cm-formatting (dimmed)", async () => {
    await sourceLine(cm, "**bold**", "bold");
    // #5: click into a bold word so its `**` markers reveal; they must carry
    // cm-formatting-strong so the theme greys them.
    await cm.locator(".ofm-strong", { hasText: "bold" }).first().click();
    await win.waitForTimeout(300);
    const marker = cm.locator(".cm-formatting-strong");
    await marker.first().waitFor({ state: "attached", timeout: 4000 });
    assert.ok((await marker.count()) >= 1, "revealed `**` should be cm-formatting-strong");
  });

  await test("aliased callout type ([!important]) gets a color, not gray fallback", async () => {
    await sourceLine(cm, "[!important] Key", "Key");
    const color = await cm.evaluate(() => {
      const el = document.querySelector(".cm-line.ofm-callout-important.ofm-callout-title");
      return el ? getComputedStyle(el).color : null;
    });
    assert.ok(color, "[!important] callout title line exists");
    assert.notEqual(color, "rgb(136, 136, 136)", "must not be the #888 default-gray fallback");
  });

  await test("unordered list markers render as bullets (cursor off-line)", async () => {
    // Move the cursor away from the list lines so the markers project.
    await (await sourceLine(cm, "plain line")).click();
    await win.waitForTimeout(300);
    await sourceLine(cm, "apple");
    const bullets = cm.locator(".ofm-list-bullet");
    await bullets.first().waitFor({ state: "attached", timeout: 5000 });
    assert.ok((await bullets.count()) >= 2, "apple/banana should render bullets");
  });

  await test("in-editor find panel opens on Mod-F (@codemirror/search)", async () => {
    const selectedMatchLineText = () =>
      cm.evaluate(() => {
        const match = document.querySelector(".cm-searchMatch-selected");
        return match?.closest(".cm-line")?.textContent ?? "";
      });

    await (await sourceLine(cm, "plain line")).click();
    await win.keyboard.press("Control+Home");
    await win.waitForTimeout(200);
    await win.keyboard.press("Control+f");
    const panel = cm.locator(".cm-panel.cm-search");
    await panel.first().waitFor({ state: "visible", timeout: 4000 });
    assert.ok((await panel.count()) > 0, "the search panel should open");
    await panel.locator("input[name='search']").first().waitFor({ state: "visible", timeout: 4000 });
    await win.keyboard.press("Control+a");
    await win.keyboard.type("plain");
    await win.keyboard.press("Enter");
    await win.waitForTimeout(300);
    const firstActive = await selectedMatchLineText();
    assert.ok(
      firstActive.includes("> plain quote"),
      `Enter should jump to the first match, active line was: ${JSON.stringify(firstActive)}`
    );
    await win.keyboard.press("Enter");
    await win.waitForTimeout(300);
    const secondActive = await selectedMatchLineText();
    assert.ok(
      secondActive.includes("plain line"),
      `Enter should jump to the next match, active line was: ${JSON.stringify(secondActive)}`
    );
    // The host can echo select-all after typing starts. Both search fields
    // must handle the shortcut synchronously without a delayed second selection.
    const originalDocument = await cm.evaluate(() => document.querySelector('.cm-content').cmTile.root.view.state.doc.toString());
    for (const name of ['search', 'replace']) {
      const input = panel.locator('input[name="' + name + '"]').first();
      await input.click();
      for (let cycle = 0; cycle < 20; cycle++) {
        const query = 'plain-' + name + '-' + cycle;
        await win.keyboard.press('Control+a');
        await win.keyboard.type(query);
        assert.equal(await input.inputValue(), query, name + ' must retain every character after select-all');
      }
    }
    assert.equal(await cm.evaluate(() => document.querySelector('.cm-content').cmTile.root.view.state.doc.toString()), originalDocument, 'typing in search fields must not edit the document');
    await win.keyboard.press("Escape"); // close so it doesn't shift later layout
    await win.waitForTimeout(200);
  });

  await test("regular [text](url) renders as a link with URL hidden", async () => {
    await sourceLine(cm, "A [real link]", "real link");
    const link = cm.locator(".ofm-external-link", { hasText: "real link" });
    await link.first().waitFor({ state: "attached", timeout: 5000 });
    assert.equal(await link.getAttribute("data-ofm-link"), "https://example.com");
    // The raw URL / parens must not be visible anywhere in the rendered content.
    const allText = await cm.locator(".cm-content").innerText();
    assert.ok(
      !allText.includes("(https://example.com)"),
      "the (url) part should be hidden in Live Preview"
    );
  });

  await test("note embed ![[Note]] renders as a clickable embed chip", async () => {
    await sourceLine(cm, "Embed note", "Embed note");
    const chip = cm.locator(".ofm-embed", { hasText: "Other Note" });
    await chip.first().waitFor({ state: "attached", timeout: 5000 });
    assert.equal(await chip.first().getAttribute("data-ofm-link"), "Other Note");
    // The raw ![[ ]] syntax must not be visible in Live Preview.
    const allText = await cm.locator(".cm-content").innerText();
    assert.ok(!allText.includes("![[Other Note]]"), "raw embed syntax should be hidden");
  });

  await test("GFM table renders as an HTML table", async () => {
    await sourceWidget(cm, "| Feature | Status |", '.ofm-table:has(th:text-is("Feature"))');
    await cm.locator(".ofm-table").first().waitFor({ state: "attached", timeout: 5000 });
    assert.ok(
      (await cm.locator(".ofm-table th").count()) >= 2,
      "table should render header cells"
    );
  });

  await test("table with a trailing-space delimiter row still renders (tolerant detector)", async () => {
    await sourceWidget(cm, "| Trail | Col |", '.ofm-table:has(th:text-is("Trail"))');
    // @lezer/markdown drops a table whose delimiter row has trailing whitespace;
    // our findTableBlocks detector tolerates it. Regression for the real-world file.
    const trail = cm.locator(".ofm-table th", { hasText: "Trail" });
    await trail.first().waitFor({ state: "attached", timeout: 5000 });
    assert.ok((await trail.count()) >= 1, "trailing-space-delimiter table must render");
  });

  await test("table cells render inline markdown (bold / code)", async () => {
    await sourceWidget(cm, "| Feature | Status |", '.ofm-table:has(th:text-is("Feature")) .ofm-strong');
    await cm.locator(".ofm-table").first().waitFor({ state: "attached", timeout: 5000 });
    assert.ok(
      (await cm.locator(".ofm-table .ofm-strong").count()) >= 1,
      "**Tables** should render bold inside the cell"
    );
    assert.ok(
      (await cm.locator(".ofm-table .ofm-inline-code").count()) >= 1,
      "`yes` should render inline code inside the cell"
    );
  });

  await test("table bold picks up the theme color, matching body bold", async () => {
    // Regression: table cells must emit `cm-strong` (like the body flow) so the
    // active theme colors them. Previously bare <strong> stayed neutral gray
    // while body bold was pink.
    const bodyLine = await sourceLine(cm, "**bold**", "bold");
    const bodyColor = await bodyLine.locator(".ofm-strong").evaluate((element) => getComputedStyle(element).color);
    const tableBold = await sourceWidget(cm, "| Feature | Status |", '.ofm-table:has(th:text-is("Feature")) .ofm-strong');
    const tableColor = await tableBold.evaluate((element) => getComputedStyle(element).color);
    const colors = { body: bodyColor, table: tableColor };
    assert.ok(colors.table && colors.body, "both body and table bold must exist");
    assert.equal(
      colors.table,
      colors.body,
      `table bold (${colors.table}) must match body bold (${colors.body})`
    );
  });

  await test("table cell edits in place and commits to source (no revert)", async () => {
    await sourceWidget(cm, "| Feature | Status |", '.ofm-table:has(th:text-is("Feature"))');
    const cell = cm.locator(".ofm-table td", { hasText: "Tables" }).first();
    await cell.waitFor({ state: "visible", timeout: 5000 });
    await cell.click(); // focus → shows the cell's raw source for editing
    await win.waitForTimeout(300);
    await win.keyboard.press("Control+a"); // select within the contenteditable cell
    await win.keyboard.type("EditedCell");
    await win.keyboard.press("Enter"); // blur → commit (rebuilds the table source)
    await win.waitForTimeout(1000);
    await win.keyboard.press("Control+S");
    await win.waitForTimeout(1200);
    const onDisk = readFileSync(notePath, "utf8");
    assert.ok(
      /\|\s*EditedCell\s*\|/.test(onDisk),
      `cell edit should commit to the table source; file is:\n${onDisk}`
    );
    // The edit must NOT have nuked the rest of the doc (guards Ctrl+A scope).
    assert.ok(onDisk.startsWith("# Hello World"), "rest of the document is intact");
    // The table stays RENDERED after editing (not reverted to source).
    assert.ok((await cm.locator(".ofm-table").count()) > 0, "table stays rendered");
  });

  await test("mermaid code block renders a diagram (lazy-loaded)", async () => {
    await sourceWidget(cm, "graph TD", ".ofm-mermaid");
    const svg = cm.locator(".ofm-mermaid svg").first();
    await svg.waitFor({ state: "attached", timeout: 25000 }); // lazy script + render
    assert.ok((await svg.count()) > 0, "mermaid should render an <svg>");
  });

  // Regression: block widgets (math, table, mermaid) must not desync CM6's height map,
  // or content BELOW them is click/caret offset (the "click one line above"
  // bug). "plain line" sits below the rendered math, table, AND mermaid blocks.
  await test("clicking below block widgets lands the caret on the right line", async () => {
    await win.waitForTimeout(500); // let the mermaid re-measure settle
    const target = (await sourceLine(cm, "plain line"));
    await target.scrollIntoViewIfNeeded(); // must be on-screen to click its box
    await win.waitForTimeout(200);
    const box = await target.boundingBox();
    await cm.page().mouse.click(box.x + 20, box.y + box.height / 2);
    await win.waitForTimeout(300);
    const landed = await cm.evaluate(() => {
      const s = window.getSelection();
      let n = s && s.focusNode;
      while (n && n.nodeType !== 1) n = n.parentElement;
      const l = n ? n.closest(".cm-line") : null;
      return l ? (l.textContent || "").replace(/\n/g, "") : "(none)";
    });
    assert.ok(
      landed.includes("plain line"),
      `caret must land on the clicked line below the table/mermaid, got: ${JSON.stringify(landed)}`
    );
  });

  mkdirSync(join(REPO, "out"), { recursive: true });
  await win.screenshot({ path: join(REPO, "out", "e2e-livepreview.png") });

  // note.md is still active here (has headings) → Outline panel lists them.
  await test("Mod-B wraps the selection in ** (formatting shortcut)", async () => {
    // Select the whole 'formatword' paragraph line, then Ctrl/Cmd-B.
    await (await sourceLine(cm, "formatword")).click();
    await win.keyboard.press("Home");
    await win.keyboard.press("Shift+End");
    await win.keyboard.press("Control+b");
    await win.waitForTimeout(800);
    await win.keyboard.press("Control+S");
    await win.waitForTimeout(1200);
    const onDisk = readFileSync(notePath, "utf8");
    assert.ok(
      onDisk.includes("**formatword**"),
      `Mod-B should wrap the selection in **; file is:\n${onDisk}`
    );
  });

  await test("pasting a URL over a selection makes a markdown link", async () => {
    await (await sourceLine(cm, "pasteword")).click();
    await win.keyboard.press("Home");
    await win.keyboard.press("Shift+End");
    // Dispatch a real paste event carrying a URL (Chromium supports clipboardData
    // in the ClipboardEvent constructor); the CM6 paste handler transforms it.
    await cm.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData("text/plain", "https://example.com");
      const ev = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      document.querySelector(".cm-content").dispatchEvent(ev);
    });
    await win.waitForTimeout(800);
    await win.keyboard.press("Control+S");
    await win.waitForTimeout(1200);
    const onDisk = readFileSync(notePath, "utf8");
    assert.ok(
      onDisk.includes("[pasteword](https://example.com)"),
      `URL paste over selection should produce a markdown link; file is:\n${onDisk}`
    );
  });

  await test("extended task states ([/], [-]) render checkboxes + strike cancelled", async () => {
    // Click the trailing 'zzz end' line so the task lines above render unrevealed.
    await (await sourceLine(cm, "zzz end")).click();
    await win.waitForTimeout(500);
    await sourceLine(cm, "in progress task");
    const inprog = cm.locator('.ofm-task-checkbox[data-task="/"]');
    const cancelled = cm.locator('.ofm-task-checkbox[data-task="-"]');
    await inprog.first().waitFor({ state: "attached", timeout: 5000 });
    assert.ok((await inprog.count()) > 0, "expected an in-progress [/] checkbox");
    assert.ok((await cancelled.count()) > 0, "expected a cancelled [-] checkbox");
    const struck = await cm.evaluate(() => {
      const line = document.querySelector('.HyperMD-task-line[data-task="-"]');
      return line ? getComputedStyle(line).textDecorationLine : "";
    });
    assert.ok(
      /line-through/.test(struck),
      `cancelled task line should be struck through, got: ${struck}`
    );
  });

  await test("[[ autocomplete suggests vault notes and inserts the wikilink", async () => {
    await (await sourceLine(cm, "zzz end")).click();
    await win.keyboard.press("End");
    await win.keyboard.press("Enter");
    await win.keyboard.type("[[Other", { delay: 40 });
    // The completion tooltip lists vault notes (Other Note.md is in the fixture).
    const tip = cm.locator(".cm-tooltip-autocomplete");
    await tip.first().waitFor({ state: "attached", timeout: 5000 });
    const opts = await tip.locator("li").allInnerTexts();
    assert.ok(
      opts.some((t) => /Other Note/.test(t)),
      `[[ completion should list 'Other Note', got: ${JSON.stringify(opts)}`
    );
    await win.keyboard.press("Enter"); // accept → inserts the name + ]]
    await win.waitForTimeout(600);
    await win.keyboard.press("Control+S");
    await win.waitForTimeout(1200);
    const onDisk = readFileSync(notePath, "utf8");
    assert.ok(
      onDisk.includes("[[Other Note]]"),
      `accepting [[ completion should yield [[Other Note]]; file is:\n${onDisk}`
    );
  });

  await test("# autocomplete suggests vault tags", async () => {
    await (await sourceLine(cm, "zzz end")).click();
    await win.keyboard.press("End");
    await win.keyboard.press("Enter");
    await win.keyboard.type("#pro", { delay: 40 });
    const tip = cm.locator(".cm-tooltip-autocomplete");
    await tip.first().waitFor({ state: "attached", timeout: 5000 });
    const opts = await tip.locator("li").allInnerTexts();
    assert.ok(
      opts.some((t) => /project/.test(t)),
      `# completion should list the 'project' tag, got: ${JSON.stringify(opts)}`
    );
    await win.keyboard.press("Escape");
    await win.keyboard.press("Control+S"); // don't leave note.md dirty
    await win.waitForTimeout(600);
  });

  // NOTE: image paste runs BEFORE the folding test on purpose — the viewport is
  // still near the bottom (the autocomplete tests clicked 'zzz end'), so the
  // 'zzz end' line is rendered and clickable. Folding scrolls to the top, which
  // would virtualize it out of the DOM.
  await test("pasting an image saves an attachment and inserts ![[…]]", async () => {
    await (await sourceLine(cm, "zzz end")).click();
    await win.keyboard.press("End");
    await win.keyboard.press("Enter");
    // Dispatch a paste carrying a tiny PNG File.
    await cm.evaluate((b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], "pasted.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector(".cm-content").dispatchEvent(ev);
    }, PIXEL_PNG_B64);
    // Host writes the file + replies; webview inserts the embed. Allow round-trip.
    let onDisk = "";
    for (let i = 0; i < 20; i++) {
      await win.waitForTimeout(300);
      await win.keyboard.press("Control+S");
      onDisk = readFileSync(notePath, "utf8");
      if (/!\[\[pasted\.png\]\]/.test(onDisk)) break;
    }
    assert.ok(
      /!\[\[pasted\.png\]\]/.test(onDisk),
      `image paste should insert ![[pasted.png]]; file is:\n${onDisk}`
    );
    assert.ok(
      existsSync(join(work, "pasted.png")),
      "the pasted image should be written next to the note"
    );
  });

  await test("heading fold markers appear and fold/unfold via keymap", async () => {
    // Jump to the top heading (Ctrl-Home) so a foldable heading is in the
    // viewport and the cursor sits on it (under virtualization, '.cm-line.first()'
    // is the first RENDERED line, not necessarily line 0).
    await cm.locator(".cm-content").click();
    await win.keyboard.press("Control+Home");
    await win.waitForTimeout(500);
    const marker = cm.locator(".ofm-fold-marker");
    await marker.first().waitFor({ state: "attached", timeout: 5000 });
    assert.ok((await marker.count()) > 0, "expected fold markers on heading lines");
    // Fold the section (Ctrl-Shift-[) → a fold placeholder appears.
    await win.keyboard.press("Control+Shift+BracketLeft");
    await win.waitForTimeout(400);
    assert.ok(
      (await cm.locator(".cm-foldPlaceholder").count()) > 0,
      "folding should show a fold placeholder"
    );
    // Unfold (Ctrl-Shift-]) → placeholder removed (restores the doc for later tests).
    await win.keyboard.press("Control+Shift+BracketRight");
    await win.waitForTimeout(400);
    assert.equal(
      await cm.locator(".cm-foldPlaceholder").count(),
      0,
      "unfolding should remove the placeholder"
    );
  });

  await test("Outline panel lists the note's headings", async () => {
    await openFlintmark();
    const pane = win.locator(".pane").filter({ hasText: /Outline/i }).first();
    const rows = pane.locator(".monaco-list-row");
    await rows.first().waitFor({ state: "visible", timeout: 5000 });
    const texts = await rows.allInnerTexts();
    assert.ok(
      texts.some((t) => /Hello World/.test(t)),
      `Outline should list headings, got: ${JSON.stringify(texts)}`
    );
  });

  await test("Todo panel aggregates, navigates, and stays synced with the note", async () => {
    await openFlintmark();
    const pane = win.locator(".pane").filter({ hasText: /Todo/i }).first();
    const rows = pane.locator(".monaco-list-row");
    await rows.first().waitFor({ state: "visible", timeout: 5000 });

    const initialTexts = await rows.allInnerTexts();
    for (const expected of ["my task", "in progress task", "cancelled task"]) {
      assert.ok(
        initialTexts.some((text) => text.includes(expected)),
        `Todo should list ${JSON.stringify(expected)}, got: ${JSON.stringify(initialTexts)}`
      );
    }
    assert.ok(
      initialTexts.some((text) => text.includes("my task") && /\[[xX]\]/.test(text)),
      `the earlier checkbox update must be reflected in Todo, got: ${JSON.stringify(initialTexts)}`
    );

    const inProgress = rows.filter({ hasText: "in progress task" }).first();
    await inProgress.click();
    await win.waitForTimeout(700);
    const todoBefore = {
      ui: await captureTriage("todo-before-input", { phase: "after-row-click" }),
      cm: await captureCmState(cm, "todo-before-input"),
      disk: readFileSync(notePath, "utf8").slice(-400),
    };
    console.log("TODO_DIAGNOSTIC_BEFORE " + JSON.stringify(todoBefore));
    const activeLine = await cm.evaluate(() => {
      const selection = window.getSelection();
      let node = selection && selection.focusNode;
      while (node && node.nodeType !== 1) node = node.parentElement;
      const line = node ? node.closest(".cm-line") : null;
      return line ? line.textContent || "" : "(none)";
    });
    assert.ok(
      activeLine.includes("in progress task"),
      `clicking Todo should reveal its source line, got: ${JSON.stringify(activeLine)}`
    );

    // The Todo click focuses CM6. Edit that task and require the already-open
    // sidebar row to update without a manual refresh or a second source scan.
    await win.keyboard.press("End");
    await win.keyboard.type(" updated");
    await win.waitForTimeout(900);
    const updatedTexts = await rows.allInnerTexts();
    const todoAfter = {
      ui: await captureTriage("todo-after-input", { phase: "after-typing" }),
      cm: await captureCmState(cm, "todo-after-input"),
      disk: readFileSync(notePath, "utf8").slice(-400),
      rows: updatedTexts,
    };
    console.log("TODO_DIAGNOSTIC_AFTER " + JSON.stringify(todoAfter));
    assert.ok(
      updatedTexts.some((text) => text.includes("in progress task updated")),
      `Todo should live-update after the article edit, got: ${JSON.stringify(updatedTexts)}; diagnostic=${JSON.stringify({ before: todoBefore, after: todoAfter })}`
    );
    await win.keyboard.press("Control+S");
    await win.waitForTimeout(500);
  });

  // Navigates away from note.md: wiki-link click resolves via Vault Index.
  await test("clicking a [[wikilink]] opens the target note (Vault Index)", async () => {
    await cm
      .locator(".ofm-internal-link", { hasText: "Other Note" })
      .first()
      .click();
    const tab = win.locator(".tab", { hasText: "Other Note" });
    await tab.first().waitFor({ state: "visible", timeout: 6000 });
    assert.ok((await tab.count()) > 0, "a tab for Other Note should open");
  });

  // Other Note is active now; note.md links to it → backlinks should list "note".
  await test("backlinks panel lists notes that link to the active note", async () => {
    await openFlintmark();
    await palette("Control+Shift+P", "Refresh Backlinks");
    await win.waitForTimeout(800);
    const pane = win.locator(".pane").filter({ hasText: /Backlinks/i }).first();
    const row = pane.locator(".monaco-list-row", { hasText: "note" });
    await row.first().waitFor({ state: "visible", timeout: 5000 });
    assert.ok((await row.count()) > 0, "backlinks should list the linking note");
  });

  // Last (flips note.md to source): AI Selection Bridge via the floating button.
  await test("AI bridge: selection button relocates the selection to native source", async () => {
    await palette("Control+P", "note.md");
    const cm2 = await findCmFrame(8000);
    assert.ok(cm2, "note.md reopened in Live Preview");
    // Select a word in the heading (top of doc → reveal keeps line 1 visible).
    await (await sourceLine(cm2, "Hello World")).dblclick();
    await win.waitForTimeout(400);
    const aiBefore = {
      ui: await captureTriage("ai-before-button-wait", { target: "heading-first-line" }),
      cm: await captureCmState(cm2, "ai-before-button-wait"),
    };
    console.log("AI_SELECTION_BEFORE " + JSON.stringify(aiBefore));
    // The floating toolbar appears with BOTH "Edit" and "Add to Chat".
    const editBtn = cm2.locator(".ofm-ai-button", { hasText: "Edit" }).first();
    try {
      await editBtn.waitFor({ state: "visible", timeout: 4000 });
    } catch (error) {
      const aiFailed = {
        before: aiBefore,
        after: await captureCmState(cm2, "ai-after-button-wait"),
        ui: await captureTriage("ai-button-hidden", { error: String(error.message || error) }),
      };
      console.log("AI_SELECTION_DIAGNOSTIC " + JSON.stringify(aiFailed));
      throw new Error(`${error.message}; AI diagnostic=${JSON.stringify(aiFailed)}`);
    }
    assert.ok(
      (await cm2.locator(".ofm-ai-button", { hasText: "Add to Chat" }).count()) > 0,
      "the Add to Chat button should also be present"
    );
    await editBtn.click();
    await win.waitForTimeout(1800);
    // The tab is now a native Monaco text editor showing the RAW markdown.
    const lines = win.locator(".monaco-editor .view-lines");
    await lines.first().waitFor({ state: "visible", timeout: 6000 });
    // Source view shows RAW markdown markers (** , #) that Live Preview hides.
    // Use **bold** (no spaces) so Monaco's nbsp rendering can't trip the check.
    const txt = await lines.first().innerText();
    assert.ok(
      txt.includes("**bold**"),
      `source editor should show RAW markdown (** markers), got: ${JSON.stringify(txt.slice(0, 80))}`
    );
  });

  // Our own Live/Code toggle buttons (editor title) — switch views losslessly.
  await test("Live/Code toggle: switch to source and back keeps the theme", async () => {
    await palette("Control+P", "note.md");
    await win.waitForTimeout(800);
    // Prior test may have left note.md in source — get to Live first.
    if(IS_CURSOR) await palette("F1",">Flintmark: Switch to Live View");
    const liveBtn = win.locator('.editor-actions [aria-label*="Live View"]');
    if (await liveBtn.count()) {
      await liveBtn.first().click();
      await win.waitForTimeout(2000);
    }
    assert.ok(await findCmFrame(8000), "Live Preview is open");
    // Live → Code
    if(IS_CURSOR) await palette("F1",">Flintmark: Switch to Code View"); else await win.locator('.editor-actions [aria-label*="Code View"]').first().click();
    await win.waitForTimeout(1500);
    assert.ok(
      (await win.locator(".monaco-editor .view-lines").count()) > 0,
      "source (Code view) is shown after clicking Code"
    );
    // Code → Live (must come back themed, no style loss)
    if(IS_CURSOR) await palette("F1",">Flintmark: Switch to Live View"); else await win.locator('.editor-actions [aria-label*="Live View"]').first().click();
    await win.waitForTimeout(2000);
    const frame = await findCmFrame(8000);
    assert.ok(frame, "Live Preview returns after clicking Live");
    const themed = await frame
      .locator(".ml-root")
      .first()
      .evaluate((el) => getComputedStyle(el).getPropertyValue("--text-normal").trim().length > 0)
      .catch(() => false);
    assert.ok(themed, "theme intact after switching back (no style loss)");
  });

  // ── Dedicated features.md fixture (callout default title + %% comments) ──
  // Opened LAST so it can't perturb the position-sensitive note.md tests above.
  // Multiple cm frames may exist (note.md's webview lingers), so select the
  // frame by CONTENT unique to features.md rather than "the first cm frame".
  const featuresFrame = async () => {
    for (let i = 0; i < 24; i++) {
      for (const f of win.frames()) {
        try {
          if ((await f.locator(".cm-content").count()) === 0 || !await isVisibleFrame(f)) continue;
          const t = await f.evaluate(() => document.querySelector(".cm-content")?.cmTile?.root?.view?.state.doc.toString() || "");
          if (t.includes("body only")) return f;
        } catch {}
      }
      await win.waitForTimeout(300);
    }
    return null;
  };
  let featCm = null;
  const showFeatureProperties = async () => {
    const fcm = featCm || (await featuresFrame());
    assert.ok(fcm, "features.md frame found");
    await (await sourceLine(fcm, "body only")).click();
    await win.waitForTimeout(300);
    await revealSource(fcm, "title: Features");
    await fcm.locator(".ofm-properties").first().waitFor({ state: "attached", timeout: 5000 });
    return fcm;
  };
  await test("callout with no custom title shows the capitalized type name", async () => {
    // Earlier tests called openFlintmark(), which replaced the Explorer with our
    // container — reopen the Explorer so the features.md row exists to click.
    await palette("F1", ">View: Show Explorer");
    await win.waitForTimeout(700);
    const row = win.locator(".monaco-list-row").filter({ hasText: "features.md" }).first();
    await row.dblclick(); // force-open (not just select/preview) regardless of editor state
    await win.waitForTimeout(800);
    featCm = await featuresFrame();
    assert.ok(featCm, "features.md opened in Live Preview");
    const label = await featCm.evaluate(() => {
      const el = document.querySelector(".ofm-callout-default-title");
      return el ? el.textContent : null;
    });
    assert.equal(label, "Note", "[!note] with no title should display 'Note'");
  });

  await test("inline SVG HTML block renders as a sanitized image", async () => {
    const fcm = featCm || (await featuresFrame());
    assert.ok(fcm, "features.md frame found");
    await fcm.locator("img.ofm-svg-block-image").first().waitFor({ state: "attached", timeout: 5000 });
    await fcm.evaluate(() => {
      delete (window).__ofmSvgUnsafe;
      const img = document.querySelector("img.ofm-svg-block-image");
      if (img instanceof HTMLImageElement) img.src = img.src;
    });
    for (let i = 0; i < 20; i++) {
      const loaded = await fcm.evaluate(() => {
        const img = document.querySelector("img.ofm-svg-block-image");
        return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
      });
      if (loaded) break;
      await win.waitForTimeout(250);
    }
    const r = await fcm.evaluate(() => {
      const img = document.querySelector("img.ofm-svg-block-image");
      const src = img?.getAttribute("src") ?? "";
      const payload = src.includes(",") ? decodeURIComponent(src.slice(src.indexOf(",") + 1)) : "";
      return {
        hasImg: !!img,
        loaded: img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0,
        srcPrefix: src.slice(0, 30),
        payload,
        visibleText: document.querySelector(".cm-content")?.textContent ?? "",
        unsafeRan: Boolean((window).__ofmSvgUnsafe),
      };
    });
    assert.ok(r.hasImg, "expected SVG block to render as an <img>");
    assert.ok(r.loaded, "sanitized SVG image should load");
    assert.ok(r.srcPrefix.startsWith("data:image/svg+xml"), `unexpected src: ${r.srcPrefix}`);
    assert.ok(!r.visibleText.includes("<svg"), "raw SVG source should be hidden while unrevealed");
    assert.ok(!/script|onload|onclick|javascript:/i.test(r.payload), `unsafe SVG payload leaked: ${r.payload}`);
    assert.equal(r.unsafeRan, false, "unsafe SVG script/event handlers must not run");
  });

  await test("fresh-open YAML frontmatter defaults to the Properties panel", async () => {
    const fcm = featCm || (await featuresFrame());
    assert.ok(fcm, "features.md frame found");
    await revealSource(fcm, "title: Features");
    await fcm.locator(".ofm-properties").first().waitFor({ state: "attached", timeout: 5000 });
    const sourceLines = await fcm.locator(".cm-line").filter({ hasText: "title: Features" }).count();
    assert.equal(sourceLines, 0, "fresh open should not reveal raw YAML frontmatter source");
  });

  await test("YAML frontmatter renders as a Properties panel with chips", async () => {
    const fcm = await showFeatureProperties();
    const r = await fcm.evaluate(() => {
      const panel = document.querySelector(".ofm-properties");
      const header = document.querySelector(".ofm-properties-header");
      const keys = [...document.querySelectorAll(".ofm-prop-key")].map((e) => e.textContent);
      const chips = [...document.querySelectorAll(".ofm-prop-chip")].map((e) => e.textContent);
      const icons = [...document.querySelectorAll(".ofm-prop-icon svg")].length;
      return { hasPanel: !!panel, header: header?.textContent || "", keys, chips, icons };
    });
    assert.ok(r.hasPanel, "expected an .ofm-properties panel");
    assert.equal(r.header, "Properties", `expected a "Properties" header, got: ${r.header}`);
    assert.ok(r.keys.includes("title") && r.keys.includes("tags"), `keys: ${JSON.stringify(r.keys)}`);
    assert.ok(r.chips.includes("demo") && r.chips.includes("test"), `tag chips: ${JSON.stringify(r.chips)}`);
    // One leading type icon per property row.
    assert.equal(r.icons, r.keys.length, `expected ${r.keys.length} icons, got ${r.icons}`);
  });

  await test("clicking the YAML Properties panel reveals editable frontmatter source", async () => {
    const fcm = await showFeatureProperties();
    const panel = fcm.locator(".ofm-properties").first();
    await panel.waitFor({ state: "attached", timeout: 5000 });
    await panel.click();
    await win.waitForTimeout(300);
    await fcm
      .locator(".cm-line")
      .filter({ hasText: "title: Features" })
      .first()
      .waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await fcm.locator(".ofm-properties").count(), 0, "panel hides while YAML source is active");

    await (await sourceLine(fcm, "body only")).click();
    await win.waitForTimeout(300);
    await revealSource(fcm, "title: Features");
    await fcm.locator(".ofm-properties").first().waitFor({ state: "attached", timeout: 5000 });
  });

  await test("clicking below YAML Properties lands the caret on the clicked line", async () => {
    const fcm = await showFeatureProperties();
    const heading = await sourceLine(fcm, "# Features", "Features");
    await heading.scrollIntoViewIfNeeded();
    await win.waitForTimeout(200);
    const box = await heading.boundingBox();
    assert.ok(box, "# Features heading should have a box");
    await fcm.page().mouse.click(box.x + 20, box.y + box.height / 2);
    await win.waitForTimeout(300);
    const landed = await fcm.evaluate(() => {
      const s = window.getSelection();
      let n = s && s.focusNode;
      while (n && n.nodeType !== 1) n = n.parentElement;
      const l = n ? n.closest(".cm-line") : null;
      return l ? (l.textContent || "").replace(/\n/g, "") : "(none)";
    });
    assert.ok(
      landed.includes("Features"),
      `caret must land on the clicked heading below frontmatter, got: ${JSON.stringify(landed)}`
    );
  });

  await test("%% comments are hidden in preview (cursor elsewhere)", async () => {
    const fcm = featCm || (await featuresFrame());
    assert.ok(fcm, "features.md frame found");
    const txt = await fcm.evaluate(() => document.querySelector(".cm-content").innerText);
    assert.ok(txt.includes("body only"), "sanity: we are reading features.md");
    assert.ok(!txt.includes("secretcomment"), "%% comment body must be hidden");
  });

  await test("footnotes render as superscript labels with the [^…] syntax hidden", async () => {
    const fcm = featCm || (await featuresFrame());
    const r = await fcm.evaluate(() => {
      const refs = [...document.querySelectorAll(".ofm-footnote-ref")];
      const txt = document.querySelector(".cm-content").innerText;
      return {
        count: refs.length,
        sup: refs.every((e) => getComputedStyle(e).verticalAlign === "super"),
        bracketsHidden: !txt.includes("[^1]"),
      };
    });
    assert.ok(r.count >= 2, "ref + definition label both rendered");
    assert.ok(r.sup, "footnote labels are superscript");
    assert.ok(r.bracketsHidden, "`[^1]` syntax must be hidden");
  });

  await test("SQL code blocks are syntax-highlighted", async () => {
    const fcm = featCm || (await featuresFrame());
    const kw = await fcm.evaluate(() => document.querySelectorAll(".cm-keyword").length);
    assert.ok(kw > 0, "SQL keywords (SELECT/FROM/WHERE) should be highlighted");
  });

  await test("bare ![[deep.png]] resolves vault-wide to a subfolder attachment", async () => {
    const fcm = featCm || (await featuresFrame());
    // The image index builds asynchronously; on ready it re-sends the imageMap
    // and the embed's <img> src flips from the legacy doc-relative guess to the
    // vault-resolved attachments/ path. Poll for that.
    let src = null;
    for (let i = 0; i < 30; i++) {
      src = await fcm.evaluate(() => {
        const img = document.querySelector("img.ofm-image");
        return img ? img.getAttribute("src") : null;
      });
      if (src && /attachments\/deep\.png/.test(src)) break;
      await win.waitForTimeout(500);
    }
    assert.ok(
      src && /attachments\/deep\.png/.test(src) && /^(https?:|vscode-webview:)/.test(src),
      `bare ![[deep.png]] should resolve vault-wide to attachments/deep.png, got: ${src}`
    );
  });

  await test("exact table heights keep fast scrolling and layout invalidation stable", async () => {
    viewportWarnings.length = 0;
    await palette("Control+P", "long-scroll.md");
    let longCm = null;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !longCm) {
      for (const f of win.frames()) {
        try {
          if ((await f.locator(".cm-content").count()) === 0 || !await isVisibleFrame(f)) continue;
          const text = await f.locator(".cm-content").first().innerText();
          if (text.includes("Long Scroll Section")) {
            longCm = f;
            break;
          }
        } catch {}
      }
      if (!longCm) await win.waitForTimeout(250);
    }
    assert.ok(longCm, "long-scroll.md opened in Live Preview");
    mkdirSync(TRIAGE_OUT,{recursive:true});
    const originalLayoutWait = longCm.waitForFunction.bind(longCm);
    longCm.waitForFunction = async (...args) => {
      const started = performance.now(); let error = null;
      try { return await originalLayoutWait(...args); }
      catch (e) { error = String(e); throw e; }
      finally {
        writeFileSync(join(TRIAGE_OUT,'layout-waits.jsonl'), JSON.stringify({
          elapsedMs:performance.now()-started,error,argument:args[1],predicate:String(args[0]),
          detailedAnchorTrace:process.env.FLINTMARK_DETAILED_ANCHOR_TRACE==='1'
        })+'\n',{flag:'a'});
      }
    };


    const scroller = longCm.locator(".cm-scroller").first();
    const box = await scroller.boundingBox();
    assert.ok(box, "long-scroll editor scroller should have a box");
    await longCm.waitForFunction(
      () =>
        document.querySelector(".ofm-table-measure-rack")?.getAttribute(
          "data-ofm-table-measurements-pending"
        ) === "0",
      null,
      { timeout: 15_000 }
    );
    const initialContract = await longCm.evaluate((cutoff) => {
      const tables = [...document.querySelectorAll(".ofm-table-wrap")];
      const errors = tables.map((element) =>
        Math.abs(
          element.getBoundingClientRect().height -
            Number(element.getAttribute("data-ofm-estimated-height"))
        )
      );
      return {
        cutoff,
        layoutVersion: Number(
          document.querySelector(".ofm-table-measure-rack")?.getAttribute(
            "data-ofm-table-layout-version"
          ) ?? 0
        ),
        mountedTables: tables.length,
        maxErrorPx: errors.length ? Math.max(...errors) : null,
        firstTable: tables[0]
          ? (() => {
              const element = tables[0];
              const content = document.querySelector(".cm-content");
              const style = getComputedStyle(element);
              const contentStyle = content ? getComputedStyle(content) : null;
              return {
                estimate: element.getAttribute("data-ofm-estimated-height"),
                height: element.getBoundingClientRect().height,
                width: element.getBoundingClientRect().width,
                offsetHeight: element.offsetHeight,
                clientHeight: element.clientHeight,
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth,
                childWidth: element.firstElementChild?.getBoundingClientRect().width ?? 0,
                childHeight: element.firstElementChild?.getBoundingClientRect().height ?? 0,
                parent: element.parentElement?.className ?? "",
                parentWidth: element.parentElement?.getBoundingClientRect().width ?? 0,
                fontSize: style.fontSize,
                lineHeight: style.lineHeight,
                padding: style.padding,
                contentWidth: content?.getBoundingClientRect().width ?? 0,
                contentPadding: contentStyle
                  ? `${contentStyle.paddingLeft} ${contentStyle.paddingRight}`
                  : "",
              };
            })()
          : null,
      };
    }, LIVE_PREVIEW_DECORATION_CHAR_LIMIT);
    assert.ok(
      LONG_SCROLL.length < initialContract.cutoff,
      `fixture must remain below cutoff: ${JSON.stringify(initialContract)}`
    );
    assert.ok(initialContract.mountedTables > 0, "at least one measured TableWidget must mount");
    assert.ok(
      initialContract.maxErrorPx !== null && initialContract.maxErrorPx <= 2,
      `offscreen prediction must match the mounted wrapper within 2px: ${JSON.stringify(initialContract)}`
    );

    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const samples = [];
    const visitedTables = new Set();
    let maxPredictionErrorPx = 0;
    const wheelSnapshot = () => scroller.evaluate((element) => {
        const tables = [...document.querySelectorAll(".ofm-table-wrap")];
        return {
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          tableIds: tables.map((table) => table.getAttribute("data-ofm-table-from")),
          errors: tables.map((table) =>
            Math.abs(
              table.getBoundingClientRect().height -
                Number(table.getAttribute("data-ofm-estimated-height"))
            )
          ),
        };
      });
    for (let i = 0; i < 80; i++) {
      const sample = await positiveWheel(win, scroller, wheelSnapshot, 1800);
      const { after } = sample;
      for (const id of after.tableIds) if (id !== null) visitedTables.add(id);
      if (after.errors.length) maxPredictionErrorPx = Math.max(maxPredictionErrorPx, ...after.errors);
      samples.push({ input: i, ...sample });
    }
    console.log("FAST_WHEEL_COMPLETION", JSON.stringify(samples.map(({ input, checkpoint, observations }) => ({ input, checkpoint, observations }))));
    await win.waitForTimeout(400);
    const visible = await longCm.evaluate(() => {
      const lineEls = [...document.querySelectorAll(".cm-line")];
      const lines = lineEls.map((e) => e.textContent || "");
      const headingTexts = [...document.querySelectorAll(".cm-line.ofm-heading-2")].map(
        (e) => e.textContent || ""
      );
      const maxSection = Math.max(
        -1,
        ...headingTexts.map((t) => Number(/Long Scroll Section (\d+)/.exec(t)?.[1] ?? -1))
      );
      return {
        lineCount: lines.length,
        nonEmpty: lines.filter((t) => t.trim()).length,
        headingTexts,
        maxSection,
        codeblockLines: document.querySelectorAll(".cm-line.ofm-codeblock").length,
        text: (document.querySelector(".cm-content")?.textContent || "").slice(0, 500),
      };
    });
    assert.ok(
      visible.lineCount > 0 && visible.nonEmpty > 0,
      `long note viewport should not be blank: ${JSON.stringify(visible)}`
    );
    assert.ok(
      visible.maxSection >= 250,
      `fast scroll should reach a middle/late heading rendered with Live Preview classes: ${JSON.stringify(visible)}`
    );
    assert.ok(
      visible.codeblockLines > 0,
      `visible code block lines should keep Live Preview codeblock classes: ${JSON.stringify(visible)}`
    );
    assert.equal(
      viewportWarnings.length,
      0,
      `CM6 viewport should stabilize while fast-scrolling long docs: ${viewportWarnings.join("\n")}`
    );
    const negativeMoves = samples.filter(
      (sample) => sample.after.scrollTop < sample.before.scrollTop - 1
    );
    const nonBottomSlips = samples.filter(
      (sample) =>
        sample.before.scrollTop <
          sample.before.scrollHeight - sample.before.clientHeight - 5 &&
        sample.after.scrollTop <= sample.before.scrollTop + 1
    );
    const heightRegressions = samples.filter(
      (sample) => sample.after.scrollHeight < sample.before.scrollHeight - 1
    );
    assert.equal(
      negativeMoves.length,
      0,
      `positive wheels must not move upward: ${JSON.stringify(negativeMoves)}`
    );
    assert.equal(
      nonBottomSlips.length,
      0,
      `positive wheels must advance before bottom: ${JSON.stringify(nonBottomSlips)}`
    );
    console.log("VIRTUALIZED_HEIGHT_REFINEMENTS", JSON.stringify(heightRegressions));
    assert.ok(
      visitedTables.size >= 4,
      `scrolling must encounter several mounted large tables, got ${visitedTables.size}`
    );
    assert.ok(
      maxPredictionErrorPx <= 2,
      `all encountered table estimates must stay within 2px, got ${maxPredictionErrorPx}`
    );

    await verifyVisibleWheelDisplacement(win, scroller);

    // The fast-scroll phase may finish at maxScroll. CM6 correctly anchors the
    // document bottom there, which is a different contract from preserving the
    // first visible source line. Move to a stable middle position before testing
    // viewport-source anchoring across a real settings invalidation.
    await scroller.evaluate((element) => {
      const maxScroll = element.scrollHeight - element.clientHeight;
      element.scrollTop = Math.round(maxScroll * 0.7);
    });
    await win.waitForTimeout(350);
    const offBottom = await scroller.evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      distanceFromBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
    }));
    assert.ok(
      offBottom.distanceFromBottom >= offBottom.clientHeight * 2,
      `anchor setup must be away from document bottom: ${JSON.stringify(offBottom)}`
    );

    const readAnchorState = (fixedPos = null) => longCm.evaluate((fixedPos) => {
      const content = document.querySelector(".cm-content");
      const view = content?.cmTile?.root?.view;
      const scroller = document.querySelector(".cm-scroller");
      if (!view || !scroller) return null;
      const scrollerTop = scroller.getBoundingClientRect().top;
      const lines = [...document.querySelectorAll(".cm-line")]
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom > scrollerTop + 0.5)
        .sort((a, b) => a.rect.top - b.rect.top);
      const first = lines[0];
      const firstPos = first ? view.posAtDOM(first.element) : null;
      const anchorPos = fixedPos === null ? view.scrollSnapshot().value.range.head : fixedPos;
      const anchorLine = view.state.doc.lineAt(anchorPos);
      const coords = view.coordsAtPos(anchorPos);
      const block=view.lineBlockAt(anchorPos);
      if (!block || !Number.isFinite(block.top) || !Number.isFinite(view.documentTop) || !Number.isFinite(scrollerTop)) return null;
      const dom=view.domAtPos(anchorPos).node;
      const lineDom=(dom.nodeType===1?dom:dom.parentElement)?.closest(".cm-line");
      const lineRect=lineDom?.getBoundingClientRect();
      return {
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        distanceFromBottom: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
        anchor: {
          pos: anchorPos,
          line: anchorLine.number,
          text: anchorLine.text,
          top: coords ? coords.top - scrollerTop : null,
          lineBlockTop: view.documentTop+block.top-scrollerTop,
          lineBlockHeight:block.height,
          lineDomTop:lineRect?lineRect.top-scrollerTop:null,
          lineDomHeight:lineRect?.height,
          glyphWithinLine:coords&&lineRect?coords.top-lineRect.top:null,
          snapshotMargin:view.scrollSnapshot().value.yMargin,
        },
        firstVisible: first ? {
          pos: firstPos,
          line: view.state.doc.lineAt(firstPos).number,
          text: first.element.textContent || "",
          top: first.rect.top - scrollerTop,
          height: first.rect.height,
        } : null,
        lineHeight: view.defaultLineHeight,
      };
    }, fixedPos);

    // CM6 anchors a source line block. Font metrics can move glyphs within
    // that block, so keep glyph geometry as a separate diagnostic.
    // 1. The source line-block offset must stay within 2px.
    // 2. The source line at the top edge may move by at most one line when
    //    font/width changes reflow heights, but must never jump to a new
    //    section or a line several lines away.
    const anchorProblems = (before, after) => {
      const problems = [];
      if (!after || !after.anchor || before.anchor.pos !== after.anchor.pos || before.anchor.line !== after.anchor.line || before.anchor.text !== after.anchor.text) {
        problems.push(`anchor position changed: ${before.anchor.pos} -> ${after?.anchor?.pos}`);
      }
      if (!Number.isFinite(before?.anchor?.lineBlockTop) || !Number.isFinite(after?.anchor?.lineBlockTop)) {
        problems.push("native line-block anchor has no finite coordinates");
      } else if (Math.abs(after.anchor.lineBlockTop - before.anchor.lineBlockTop) > 2) {
        problems.push(`native line-block anchor moved ${after.anchor.lineBlockTop - before.anchor.lineBlockTop}px`);
      }
      if (!after?.firstVisible) problems.push("no visible source line");
      else if (Math.abs(after.firstVisible.line - before.firstVisible.line) > 1) {
        problems.push(`top source line jumped ${before.firstVisible.line} -> ${after.firstVisible.line}`);
      }
      return problems;
    };

    const anchorBefore = await readAnchorState();
    assert.ok(anchorBefore?.firstVisible, `a visible source line must exist before settings: ${JSON.stringify(anchorBefore)}`);
    assert.ok(Number.isFinite(anchorBefore.anchor.lineBlockTop), `native line-block anchor must have coordinates: ${JSON.stringify(anchorBefore)}`);
    const blockNegative = structuredClone(anchorBefore);
    blockNegative.anchor.lineBlockTop += 40;
    assert.deepEqual(anchorProblems(anchorBefore, blockNegative), ["native line-block anchor moved 40px"]);
    const nonfiniteNegative = structuredClone(anchorBefore);
    nonfiniteNegative.anchor.lineBlockTop = NaN;
    assert.deepEqual(anchorProblems(anchorBefore, nonfiniteNegative), ["native line-block anchor has no finite coordinates"]);
    console.log("ANCHOR_BLOCK_ONLY_NEGATIVE_CONTROL_REJECTED", JSON.stringify(anchorProblems(anchorBefore, blockNegative)));

    await longCm.evaluate(installNativeAnchorTrace, anchorBefore.anchor.pos);
    const layoutVersionBeforeSettings = await longCm.evaluate(() => {
      const rack = document.querySelector(".ofm-table-measure-rack");
      return Number(rack?.getAttribute("data-ofm-table-layout-version") ?? 0);
    });
    writeSettings({ ...baseSettings, "ofm.fontSize": 13, "ofm.lineWidth": 28 });
    await longCm.waitForFunction(
      (previousVersion) => {
        const rack = document.querySelector(".ofm-table-measure-rack");
        const content = document.querySelector(".cm-content");
        const style = content ? getComputedStyle(content) : null;
        return (
          Number(rack?.getAttribute("data-ofm-table-layout-version") ?? 0) > previousVersion &&
          rack?.getAttribute("data-ofm-table-measurements-pending") === "0" &&
          style?.fontSize === "13px" &&
          style.maxWidth !== "none"
        );
      },
      layoutVersionBeforeSettings,
      { timeout: 15_000 }
    );
    // Let CM6 finish its own measure/scroll-anchor correction. This is a settle
    // gate, not a delayed scroll restore: nothing here writes scrollTop.
    await longCm.evaluate(() => new Promise((resolve) => {
      let frame = 0;
      const tick = () => {
        frame++;
        if (frame >= 4) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
    const anchorAfter = await readAnchorState(anchorBefore.anchor.pos);
    const problems = anchorProblems(anchorBefore, anchorAfter);
    console.log("ANCHOR_CONTRACT", JSON.stringify({ before: anchorBefore, after: anchorAfter, problems }));
    // Observe the full stability window; later drift must fail as well.
    const anchorSamples = [];
    const sampleStart = performance.now();
    for (;;) {
      const state = await readAnchorState(anchorBefore.anchor.pos);
      const sample = { tMs: performance.now() - sampleStart, state, problems: anchorProblems(anchorBefore, state) };
      anchorSamples.push(sample);
      if (sample.tMs >= 500) break;
      await win.waitForTimeout(16);
    }
    const nativeTrace = await longCm.evaluate(() => window.__fmNativeAnchorTrace.finish());
    mkdirSync(TRIAGE_OUT,{recursive:true});
    writeFileSync(join(TRIAGE_OUT,"native-scroll-trace.json"),JSON.stringify({before:anchorBefore,after:anchorAfter,samples:anchorSamples,...nativeTrace},null,2));
    console.log("ANCHOR_CONTRACT_500MS", JSON.stringify({ initialProblems: problems, samples: anchorSamples }));
    assert.deepEqual(problems, [], `source position jumped after font/width change: ${JSON.stringify(problems)}`);
    assert.deepEqual(anchorSamples.filter((sample) => sample.problems.length), [], "native anchor must remain stable through the full 500ms window");

    // Negative control: the same predicate must reject a synthetic broken
    // anchor (different source position / 40px drift / 5-line jump). This proves
    // the probe is sensitive without relying on the old 8px threshold.
    const negative = JSON.parse(JSON.stringify(anchorAfter));
    negative.anchor.pos += 1;
    negative.anchor.lineBlockTop -= 40;
    negative.firstVisible.line += 5;
    const negativeProblems = anchorProblems(anchorBefore, negative);
    assert.ok(negativeProblems.length >= 3, `negative control was not rejected: ${JSON.stringify(negativeProblems)}`);
    console.log("ANCHOR_NEGATIVE_CONTROL_REJECTED", JSON.stringify(negativeProblems));
    const roundTrips = [];
    for (let cycle = 0; cycle < 12; cycle++) for (const layout of ["base", "changed"]) {
      const startState = await readAnchorState(anchorBefore.anchor.pos);
      await longCm.evaluate(installNativeAnchorTrace, anchorBefore.anchor.pos);
      const previousVersion = await longCm.evaluate(() => Number(document.querySelector(".ofm-table-measure-rack")?.getAttribute("data-ofm-table-layout-version") ?? 0));
      writeSettings(layout === "base" ? baseSettings : { ...baseSettings, "ofm.fontSize": 13, "ofm.lineWidth": 28 });
      await longCm.waitForFunction(({ previousVersion, font }) => {
        const rack = document.querySelector(".ofm-table-measure-rack"), content = document.querySelector(".cm-content");
        return Number(rack?.getAttribute("data-ofm-table-layout-version") ?? 0) > previousVersion && rack?.getAttribute("data-ofm-table-measurements-pending") === "0" && content && getComputedStyle(content).fontSize === font;
      }, { previousVersion, font: layout === "base" ? "9px" : "13px" }, { timeout: 15000 });
      await win.waitForTimeout(650);
      const endState = await readAnchorState(anchorBefore.anchor.pos);
      const trace = await longCm.evaluate(() => window.__fmNativeAnchorTrace.finish());
      roundTrips.push({ cycle, layout, before: startState, after: endState, trace });
      writeFileSync(join(TRIAGE_OUT,"native-roundtrip-trace.json"),JSON.stringify({diagnosticOnly:true,originalBase:anchorBefore,originalChanged:anchorAfter,roundTrips},null,2));
    }
    for (const row of roundTrips) {
      assert.equal(row.after.anchor?.pos, anchorBefore.anchor.pos, "the source anchor must survive every layout change");
      assert.ok(Math.abs(row.after.anchor.lineBlockTop - anchorBefore.anchor.lineBlockTop) <= 1, "round-trip drift must stay within one native pixel of the original anchor: " + JSON.stringify({cycle:row.cycle,layout:row.layout,before:anchorBefore.anchor.lineBlockTop,after:row.after.anchor.lineBlockTop}));
      assert.deepEqual(row.trace.events.find(e=>e.kind==="trace-end").selection,row.trace.events.find(e=>e.kind==="trace-start").selection,"layout must preserve selection");
    }
    console.log("ANCHOR_ROUNDTRIP_COMPLETE", JSON.stringify(roundTrips.map(row=>({cycle:row.cycle,layout:row.layout,blockTop:row.after?.anchor?.lineBlockTop,glyphTop:row.after?.anchor?.top}))));

    // Hold CM measurement, deliver a real wheel after CSS changes, then release.
    // The wheel's current source anchor must win over the earlier reading position.
    const held = await longCm.evaluate(() => {
      const view=document.querySelector('.cm-content').cmTile.root.view;
      const original=view.measure;
      window.__fmHeldMeasure={view,original,calls:0,selection:view.state.selection.toJSON()};
      view.measure=function(){window.__fmHeldMeasure.calls++;this.measureScheduled=-1;};
      return {version:Number(document.querySelector('.ofm-table-measure-rack').dataset.ofmTableLayoutVersion)};
    });
    writeSettings(baseSettings);
    await longCm.waitForFunction(()=>getComputedStyle(document.querySelector('.cm-content')).fontSize==='9px',null,{timeout:15000});
    const beforeWheel=await scroller.evaluate(e=>e.scrollTop);
    await win.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await win.mouse.wheel(0,-1500);
    await win.waitForTimeout(200);
    const intent=await longCm.evaluate(()=>{
      const h=window.__fmHeldMeasure,view=h.view,snapshot=view.scrollSnapshot().value;
      return {heldCalls:h.calls,scrollTop:view.scrollDOM.scrollTop,pos:snapshot.range.head,margin:snapshot.yMargin,selection:view.state.selection.toJSON(),text:view.state.doc.lineAt(snapshot.range.head).text};
    });
    assert.ok(intent.heldCalls>0,'the adversarial test must actually hold pending measurement');
    assert.ok(intent.scrollTop<beforeWheel-500,'a real wheel must move the native scroller before measurement resumes');
    await longCm.evaluate(()=>{const h=window.__fmHeldMeasure;h.view.measure=h.original;h.view.requestMeasure();});
    await longCm.waitForFunction(({version})=>{const rack=document.querySelector('.ofm-table-measure-rack');return Number(rack.dataset.ofmTableLayoutVersion)>version&&rack.dataset.ofmTableMeasurementsPending==='0';},held,{timeout:15000});
    await win.waitForTimeout(650);
    const actualIntent=await longCm.evaluate(({pos})=>{const view=document.querySelector('.cm-content').cmTile.root.view;return {scrollTop:view.scrollDOM.scrollTop,pos,margin:view.lineBlockAt(pos).top-view.scrollDOM.scrollTop,selection:view.state.selection.toJSON(),text:view.state.doc.lineAt(pos).text};},intent);
    writeFileSync(join(TRIAGE_OUT,'premeasure-wheel.json'),JSON.stringify({beforeWheel,intent,actual:actualIntent,marginError:actualIntent.margin-intent.margin},null,2));
    assert.ok(Math.abs(actualIntent.margin-intent.margin)<=1,'the new wheel anchor must survive layout, without returning to the old snapshot: '+JSON.stringify({intent,actualIntent}));
    assert.equal(actualIntent.text,intent.text);
    assert.deepEqual(actualIntent.selection,intent.selection,'scrolling and layout must preserve selection');
    console.log('PREMEASURE_REAL_WHEEL_PASSED',JSON.stringify({intent,actual:actualIntent}));
    const heightBeforeOffscreenVisit = await scroller.evaluate((element) => element.scrollHeight);
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight - element.clientHeight;
    });
    await win.waitForTimeout(500);
    const offscreenResult = await longCm.evaluate(() => {
      const scroller = document.querySelector(".cm-scroller");
      const sections = [...document.querySelectorAll(".cm-line.ofm-heading-2")]
        .map((element) => Number(/Long Scroll Section (\d+)/.exec(element.textContent ?? "")?.[1] ?? -1));
      return {
        scrollHeight: scroller?.scrollHeight ?? 0,
        maxVisibleSection: Math.max(-1, ...sections),
      };
    });
    assert.ok(
      offscreenResult.maxVisibleSection >= 400,
      `font refresh must reach correctly mapped offscreen text: ${JSON.stringify(offscreenResult)}`
    );
    assert.ok(
      Math.abs(offscreenResult.scrollHeight - heightBeforeOffscreenVisit) <= 8,
      `offscreen visit must not repair stale text heights: before=${heightBeforeOffscreenVisit}, after=${offscreenResult.scrollHeight}`
    );
    assert.equal(viewportWarnings.length, 0, "layout invalidation must not destabilize the viewport");
  });

  // Explorer single-click opens the file but leaves keyboard focus in the tree.
  // VS Code's Find still reaches a text editor from there (it runs whenever an
  // editor is open); Flintmark's Mod-F keybinding gives Live Preview the same.
  await test("Mod-F after an Explorer single-click opens find in Live Preview", async () => {
    await palette("Control+Shift+P", "View: Show Explorer");
    const row = win.locator(".explorer-folders-view .monaco-list-row", { hasText: "explorer-find.md" });
    await row.first().waitFor({ state: "visible", timeout: 5000 });
    await row.first().click();
    let frame = null;
    for (let i = 0; i < 40 && !frame; i++) {
      for (const f of win.frames()) {
        try {
          if ((await f.locator(".cm-content").count()) === 0 || !await isVisibleFrame(f)) continue;
          if ((await f.locator(".cm-content").first().innerText()).includes("explorer-find body")) frame = f;
        } catch {}
      }
      if (!frame) await win.waitForTimeout(300);
    }
    assert.ok(frame, "explorer-find.md should open in Live Preview");
    await win.waitForTimeout(500);
    const inExplorer = await win.evaluate(() => !!document.activeElement?.closest(".explorer-folders-view"));
    assert.ok(inExplorer, "single-click should leave focus in the Explorer (the case under test)");
    await win.keyboard.press("Control+f");
    const panel = frame.locator(".cm-panel.cm-search");
    await panel.first().waitFor({ state: "visible", timeout: 4000 });
    await win.waitForTimeout(300);
    const active = await frame.evaluate(() => document.activeElement?.getAttribute("name") ?? "");
    assert.equal(active, "search", "keyboard focus should be in the find input, not the text");
    await win.keyboard.type("explorer-find");
    await win.waitForTimeout(200);
    assert.equal(await panel.locator("input[name='search']").first().inputValue(), "explorer-find");
    await win.keyboard.press("Escape");
  });
} finally {
  if (failed) await captureTriage("final-failures", { failed, total }).catch(() => null);
  await app.close();
}

try {
  mkdirSync(join(REPO, "out", "metrics"), { recursive: true });
  writeFileSync(
    join(REPO, "out", "metrics", "e2e.json"),
    JSON.stringify(
      { layer: "e2e", tests: total, passed: total - failed, failed, durationMs: Date.now() - startedAt },
      null,
      2
    )
  );
} catch {
  /* best-effort */
}

if (failed > 0) {
  console.error(`\n${failed} E2E test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll E2E tests passed");

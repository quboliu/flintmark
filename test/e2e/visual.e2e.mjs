// L5 visual regression: render a fixed fixture in the real CM6 webview and
// pixel-diff KEY ELEMENTS against committed baselines. Catches unintended visual
// changes (theme/layout/widget) that behavioural e2e can't see.
//
// IMPORTANT TRADE-OFF: pixel baselines are ENVIRONMENT-SPECIFIC (font rendering
// differs across machines). So this is a LOCAL / pre-release gate, run in the
// same environment that generated the baselines — it is deliberately NOT wired
// into the cross-font CI gate (that would flake). Regenerate after intentional
// visual changes with:  node test/e2e/visual.e2e.mjs --update
//
// Element screenshots (not full-page) keep diffs stable: no window chrome, no
// caret. A small per-pixel threshold + a max-different-pixels budget absorbs
// sub-pixel antialiasing noise while still catching real changes.
import { _electron as electron } from "playwright";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { palette as openPalette } from "./quickInput.mjs";

const UPDATE = process.argv.includes("--update");
const REPO = resolve(".");
const VSCODE = process.env.VSCODE_BIN || "/usr/share/codium/codium";
const BASELINE_DIR = join(REPO, "test", "e2e", "__screenshots__");
const DIFF_DIR = join(REPO, "out", "visual-diff");
const MAX_DIFF_RATIO = 0.01; // up to 1% of pixels may differ (antialiasing slack)

let failed = 0;
const startedAt = Date.now();
const vis = { snapshots: 0, passed: 0, maxRatio: 0 };
mkdirSync(BASELINE_DIR, { recursive: true });
mkdirSync(DIFF_DIR, { recursive: true });

// --- fixture: stable, no lazy/animated widgets (no mermaid) ------------------
const work = mkdtempSync(join(tmpdir(), "ofm-visual-"));
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
    // Fixed, realistic font so element sizes are deterministic across runs.
    "editor.fontSize": 14,
  })
);
const notePath = join(work, "note.md");
writeFileSync(
  notePath,
  "# Visual Heading\n\n" +
    "Body with **bold** and `code` and ==highlight==.\n\n" +
    "> [!warning] Heads up\n> be careful here\n\n" +
    "- [ ] an unchecked task\n- [x] a done task\n\n" +
    "| Feature | Status |\n| --- | --- |\n| **Tables** | `yes` |\n\n" +
    "```rust\nfn main() {\n    let x = 42;\n}\n```\n\n" +
    "Tag: #project and a [[Wiki Link]].\n"
);

// targets: a stable CSS selector per snapshot (first match).
const TARGETS = [
  { name: "heading-h1", selector: ".cm-line.ofm-heading-1" },
  { name: "callout-warning", selector: ".cm-line.ofm-callout-warning.ofm-callout-title" },
  { name: "table", selector: ".ofm-table" },
  { name: "task-checkbox", selector: "input.ofm-task-checkbox" },
];

function compare(name, actualBuf) {
  const baseFile = join(BASELINE_DIR, `${name}.png`);
  if (UPDATE || !existsSync(baseFile)) {
    writeFileSync(baseFile, actualBuf);
    console.log(`  ⤓ ${name}: baseline ${UPDATE ? "updated" : "created"}`);
    return;
  }
  const base = PNG.sync.read(readFileSync(baseFile));
  const actual = PNG.sync.read(actualBuf);
  vis.snapshots++;
  if (base.width !== actual.width || base.height !== actual.height) {
    failed++;
    vis.maxRatio = 1;
    writeFileSync(join(DIFF_DIR, `${name}.actual.png`), actualBuf);
    console.error(
      `  ✗ ${name}: size changed ${base.width}x${base.height} -> ${actual.width}x${actual.height} (layout shift) — saved actual to out/visual-diff/`
    );
    return;
  }
  const { width, height } = base;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(base.data, actual.data, diff.data, width, height, {
    threshold: 0.1,
    includeAA: false,
  });
  const ratio = diffPixels / (width * height);
  vis.maxRatio = Math.max(vis.maxRatio, ratio);
  if (ratio > MAX_DIFF_RATIO) {
    failed++;
    writeFileSync(join(DIFF_DIR, `${name}.actual.png`), actualBuf);
    writeFileSync(join(DIFF_DIR, `${name}.diff.png`), PNG.sync.write(diff));
    console.error(
      `  ✗ ${name}: ${diffPixels} px differ (${(ratio * 100).toFixed(2)}% > ${(MAX_DIFF_RATIO * 100).toFixed(2)}%) — see out/visual-diff/${name}.diff.png`
    );
  } else {
    vis.passed++;
    console.log(`  ✓ ${name}: ${diffPixels} px differ (${(ratio * 100).toFixed(3)}%)`);
  }
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

  const palette = (combo, text) => openPalette(win, combo, text);
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
  if (!cm) throw new Error("CM6 editor (.cm-content) never appeared");

  // Settle: move the caret to the end (off the rendered blocks so no marker
  // reveal / caret appears in the element shots) and let fonts/layout finish.
  await cm.locator(".cm-content").click();
  await win.keyboard.press("Control+End");
  await win.waitForTimeout(1500);

  for (const t of TARGETS) {
    const el = cm.locator(t.selector).first();
    try {
      // "attached" (in DOM) not "visible": after Control+End some blocks scroll
      // out of the viewport; scrollIntoView brings them back before the shot.
      await el.waitFor({ state: "attached", timeout: 8000 });
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await win.waitForTimeout(250);
      const buf = await el.screenshot();
      compare(t.name, buf);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${t.name}: element not found/visible (${t.selector}) — ${e.message || e}`);
    }
  }
} finally {
  await app.close();
}

if (!UPDATE) {
  try {
    mkdirSync(join(REPO, "out", "metrics"), { recursive: true });
    writeFileSync(
      join(REPO, "out", "metrics", "visual.json"),
      JSON.stringify(
        {
          layer: "visual",
          snapshots: vis.snapshots,
          passed: vis.passed,
          failed: vis.snapshots - vis.passed,
          maxDiffRatio: Number(vis.maxRatio.toFixed(5)),
          durationMs: Date.now() - startedAt,
        },
        null,
        2
      )
    );
  } catch {
    /* best-effort */
  }
}

if (UPDATE) {
  console.log("\nBaselines written. Review them, then commit test/e2e/__screenshots__/.");
} else if (failed > 0) {
  console.error(`\n${failed} visual check(s) FAILED — inspect out/visual-diff/ (or re-baseline with --update if the change is intentional)`);
  process.exit(1);
} else {
  console.log("\nAll visual checks passed");
}

// L3 end-to-end test (docs/05): drives the REAL CM6 webview inside VSCodium
// (headless under xvfb) and asserts the user-facing Live Preview behaviour that
// L1/L2 cannot reach — marker hiding, cursor-driven Reveal, and the typing →
// disk round-trip. Run via: xvfb-run -a node test/e2e/livepreview.e2e.mjs
import { _electron as electron } from "playwright";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert";

const REPO = resolve(".");
const VSCODE = process.env.VSCODE_BIN || "/usr/share/codium/codium";

let failed = 0;
let total = 0;
const startedAt = Date.now();
async function test(name, fn) {
  total++;
  try {
    await fn();
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (e.message || e));
  }
}

// --- workspace fixture ---------------------------------------------------
const work = mkdtempSync(join(tmpdir(), "ofm-e2e-"));
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
  })
);
const notePath = join(work, "note.md");
const INITIAL =
  "# Hello World\n\nThis is **bold** text.\n\n### Subheading (Things: blue)\n\n#### Sub-subheading (Things: yellow)\n\n> [!warning] Heads up\n> be careful\n\n- [ ] my task\n\n- apple\n- banana\n\n1. first\n2. second\n\nTags: #project ==important== [[Other Note]]\n\nEmbed note ![[Other Note]] and image ![[pixel.png]]\n\n![pixel](pixel.png)\n\nMath: $e=mc^2$\n\n| Feature | Status |\n| --- | --- |\n| **Tables** | `yes` |\n\n| Trail | Col |\n|-------|-----| \n| ok | done |\n\n```rust\nfn main() {\n    let x = 42;\n}\n```\n\n```mermaid\ngraph TD\n  A[Start] --> B[Done]\n```\n\nA [real link](https://example.com) here.\n\n> plain quote\n> second\n\nSetext Two\n----------\n\n---\n\nplain line\n\n> [!important] Key\n> aliased callout type\n\nformatword\n\npasteword\n\n- [/] in progress task\n- [-] cancelled task\n\nzzz end\n";

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
  "# Features\n\n> [!note]\n> body only, no custom title\n\nVisible %%secretcomment%% visible.\n\nA claim[^1] needs a source.\n\n[^1]: the footnote definition.\n\n```sql\nSELECT id FROM users WHERE active = true;\n```\n\nVault image ![[deep.png]] from a subfolder.\n"
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
  await win.waitForTimeout(4500); // let the workbench become interactive

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
  // Open the Flintmark activity-bar container (holds Outline + Backlinks).
  // Idempotent: don't re-click if a panel is already visible (would hide it).
  async function openFlintmark() {
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
    await palette("Control+Shift+P", "Reopen Editor With"); // runs the command
    await win.keyboard.type("Markdown Live Preview"); // filter the editor picker
    await win.waitForTimeout(900);
    await win.keyboard.press("Enter");
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

  const lineText = (i) => cm.locator(".cm-line").nth(i).innerText();

  await test("our custom editor opened (not the native text editor)", async () => {
    const count = await cm.locator(".cm-content").count();
    assert.ok(count > 0, "expected a CM6 .cm-content");
  });

  await test("markers hidden when cursor is not in the construct", async () => {
    // Click the last (plain) line so the cursor is away from heading/bold.
    await cm.locator(".cm-line").last().click();
    await win.waitForTimeout(400);
    const h = await lineText(0);
    assert.ok(h.includes("Hello World"), `heading text present, got: ${JSON.stringify(h)}`);
    assert.ok(!h.includes("#"), `heading '#' should be hidden, got: ${JSON.stringify(h)}`);
    const allText = await cm.locator(".cm-content").innerText();
    assert.ok(!allText.includes("**"), "bold '**' markers should be hidden");
  });

  await test("Reveal: cursor in the heading shows the '#' marker", async () => {
    await cm.locator(".cm-line").first().click(); // cursor enters the heading
    await win.waitForTimeout(500);
    const h = await lineText(0);
    assert.ok(h.includes("#"), `heading '#' should be revealed, got: ${JSON.stringify(h)}`);
  });

  await test("typing round-trips to disk (CM6 → TextDocument → save → file)", async () => {
    // Click the "plain line" line specifically (not the trailing empty line).
    await cm.locator(".cm-line").filter({ hasText: "plain line" }).first().click();
    await win.keyboard.press("End");
    await win.keyboard.type(" EDITED");
    await win.waitForTimeout(1200); // let the serialized edits reach the host
    await win.keyboard.press("Control+S");
    await win.waitForTimeout(1500);
    const onDisk = readFileSync(notePath, "utf8");
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
    await cm.locator(".cm-line").filter({ hasText: "banana" }).first().click();
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
    const box = cm.locator("input.ofm-task-checkbox").first();
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
    await cm
      .locator(".ofm-math-inline .katex")
      .first()
      .waitFor({ state: "attached", timeout: 5000 });
    const n = await cm.locator(".ofm-math-inline .katex").count();
    assert.ok(n > 0, "KaTeX should render inside .ofm-math-inline");
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
    const kw = cm.locator(".cm-keyword");
    await kw.first().waitFor({ state: "attached", timeout: 6000 });
    assert.ok((await kw.count()) > 0, "expected highlighted .cm-keyword tokens in code");
  });

  await test("rendered code blocks show a Copy button", async () => {
    // Cursor off the code block (in the heading) so it renders boxed with flair.
    await cm.locator(".cm-line").first().click();
    await win.waitForTimeout(400);
    const copy = cm.locator(".ofm-code-copy");
    await copy.first().waitFor({ state: "attached", timeout: 5000 });
    assert.ok((await copy.count()) > 0, "expected a .ofm-code-copy button on the rendered code block");
    // Clicking it must not throw (clipboard may be unavailable headless — we only
    // assert the wiring works and the button stays in the DOM).
    await copy.first().click();
    assert.ok((await copy.count()) > 0, "copy button remains after click");
  });

  await test("body text uses a proportional font, code stays monospace", async () => {
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

  await test("headings use the theme's graduated sizes (h1 > h6 > 0)", async () => {
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
    // #5: click into a bold word so its `**` markers reveal; they must carry
    // cm-formatting-strong so the theme greys them.
    await cm.locator(".ofm-strong", { hasText: "bold" }).first().click();
    await win.waitForTimeout(300);
    const marker = cm.locator(".cm-formatting-strong");
    await marker.first().waitFor({ state: "attached", timeout: 4000 });
    assert.ok((await marker.count()) >= 1, "revealed `**` should be cm-formatting-strong");
  });

  await test("aliased callout type ([!important]) gets a color, not gray fallback", async () => {
    const color = await cm.evaluate(() => {
      const el = document.querySelector(".cm-line.ofm-callout-important.ofm-callout-title");
      return el ? getComputedStyle(el).color : null;
    });
    assert.ok(color, "[!important] callout title line exists");
    assert.notEqual(color, "rgb(136, 136, 136)", "must not be the #888 default-gray fallback");
  });

  await test("unordered list markers render as bullets (cursor off-line)", async () => {
    // Move the cursor away from the list lines so the markers project.
    await cm.locator(".cm-line").filter({ hasText: "plain line" }).first().click();
    await win.waitForTimeout(300);
    const bullets = cm.locator(".ofm-list-bullet");
    await bullets.first().waitFor({ state: "attached", timeout: 5000 });
    assert.ok((await bullets.count()) >= 2, "apple/banana should render bullets");
  });

  await test("in-editor find panel opens on Mod-F (@codemirror/search)", async () => {
    await cm.locator(".cm-line").filter({ hasText: "plain line" }).first().click();
    await win.waitForTimeout(200);
    await win.keyboard.press("Control+f");
    const panel = cm.locator(".cm-panel.cm-search");
    await panel.first().waitFor({ state: "visible", timeout: 4000 });
    assert.ok((await panel.count()) > 0, "the search panel should open");
    await win.keyboard.press("Escape"); // close so it doesn't shift later layout
    await win.waitForTimeout(200);
  });

  await test("regular [text](url) renders as a link with URL hidden", async () => {
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
    const chip = cm.locator(".ofm-embed", { hasText: "Other Note" });
    await chip.first().waitFor({ state: "attached", timeout: 5000 });
    assert.equal(await chip.first().getAttribute("data-ofm-link"), "Other Note");
    // The raw ![[ ]] syntax must not be visible in Live Preview.
    const allText = await cm.locator(".cm-content").innerText();
    assert.ok(!allText.includes("![[Other Note]]"), "raw embed syntax should be hidden");
  });

  await test("GFM table renders as an HTML table", async () => {
    await cm.locator(".ofm-table").first().waitFor({ state: "attached", timeout: 5000 });
    assert.ok(
      (await cm.locator(".ofm-table th").count()) >= 2,
      "table should render header cells"
    );
  });

  await test("table with a trailing-space delimiter row still renders (tolerant detector)", async () => {
    // @lezer/markdown drops a table whose delimiter row has trailing whitespace;
    // our findTableBlocks detector tolerates it. Regression for the real-world file.
    const trail = cm.locator(".ofm-table th", { hasText: "Trail" });
    await trail.first().waitFor({ state: "attached", timeout: 5000 });
    assert.ok((await trail.count()) >= 1, "trailing-space-delimiter table must render");
  });

  await test("table cells render inline markdown (bold / code)", async () => {
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
    const colors = await cm.evaluate(() => {
      const strongs = [...document.querySelectorAll(".ofm-strong")];
      const table = document.querySelector(".ofm-table .ofm-strong");
      const body = strongs.find((e) => !e.closest(".ofm-table"));
      const c = (el) => (el ? getComputedStyle(el).color : null);
      return { table: c(table), body: c(body) };
    });
    assert.ok(colors.table && colors.body, "both body and table bold must exist");
    assert.equal(
      colors.table,
      colors.body,
      `table bold (${colors.table}) must match body bold (${colors.body})`
    );
  });

  await test("table cell edits in place and commits to source (no revert)", async () => {
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
    const svg = cm.locator(".ofm-mermaid svg").first();
    await svg.waitFor({ state: "attached", timeout: 25000 }); // lazy script + render
    assert.ok((await svg.count()) > 0, "mermaid should render an <svg>");
  });

  // Regression: block widgets (table, mermaid) must not desync CM6's height map,
  // or content BELOW them is click/caret offset (the "click one line above"
  // bug). "plain line" sits below the table AND the rendered mermaid.
  await test("clicking below block widgets lands the caret on the right line", async () => {
    await win.waitForTimeout(500); // let the mermaid re-measure settle
    const target = cm.locator(".cm-line").filter({ hasText: "plain line" }).first();
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
    await cm.locator(".cm-line").filter({ hasText: "formatword" }).first().click();
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
    await cm.locator(".cm-line").filter({ hasText: "pasteword" }).first().click();
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
    await cm.locator(".cm-line").filter({ hasText: "zzz end" }).first().click();
    await win.waitForTimeout(500);
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
    await cm2.locator(".cm-line").first().dblclick();
    await win.waitForTimeout(400);
    // The floating toolbar appears with BOTH "Edit" and "Add to Chat".
    const editBtn = cm2.locator(".ofm-ai-button", { hasText: "Edit" }).first();
    await editBtn.waitFor({ state: "visible", timeout: 4000 });
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
    const liveBtn = win.locator('.editor-actions [aria-label*="Live View"]');
    if (await liveBtn.count()) {
      await liveBtn.first().click();
      await win.waitForTimeout(2000);
    }
    assert.ok(await findCmFrame(8000), "Live Preview is open");
    // Live → Code
    await win.locator('.editor-actions [aria-label*="Code View"]').first().click();
    await win.waitForTimeout(1500);
    assert.ok(
      (await win.locator(".monaco-editor .view-lines").count()) > 0,
      "source (Code view) is shown after clicking Code"
    );
    // Code → Live (must come back themed, no style loss)
    await win.locator('.editor-actions [aria-label*="Live View"]').first().click();
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
          if ((await f.locator(".cm-content").count()) === 0) continue;
          const t = await f.locator(".cm-content").first().innerText();
          if (t.includes("body only")) return f;
        } catch {}
      }
      await win.waitForTimeout(300);
    }
    return null;
  };
  let featCm = null;
  await test("callout with no custom title shows the capitalized type name", async () => {
    // Earlier tests called openFlintmark(), which replaced the Explorer with our
    // container — reopen the Explorer so the features.md row exists to click.
    await win.locator('.activitybar a[aria-label*="Explorer"]').first().click();
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
} finally {
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

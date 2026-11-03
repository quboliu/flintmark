import {isVisibleFrame} from './visibleFrame.mjs';
const IS_CURSOR = /cursor/i.test(process.env.VSCODE_BIN||'');
// Focused reliability E2E for the active-document Todo sidebar. Exercises the
// real VS Code TreeView, TextDocument events, CM6, source editor, filesystem
// watcher, undo/redo, tab switching, and the open-then-reveal handshake.
import {createRequire} from 'node:module';const require=createRequire(process.env.FLINTMARK_DEPS+'/package.json');const{_electron:electron}=require('playwright');
import {adaptWindow} from './native-window.mjs';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert";
import { palette as openPalette } from "./quickInput.mjs";

const REPO = process.env.FLINTMARK_REPO || resolve(".");
const VSCODE = process.env.VSCODE_BIN || "/usr/share/codium/codium";
let failed = 0;
let total = 0;


let activeWin = null;
const TRIAGE_OUT = process.env.FLINTMARK_TRIAGE_OUT || join(REPO, "out", "functional-triage");
function bounded(promise, ms, fallback) {
  let timerId;
  const timer = new Promise((resolve) => {timerId=setTimeout(() => resolve(fallback), ms);});
  return Promise.race([Promise.resolve(promise).catch(() => fallback), timer]).finally(()=>clearTimeout(timerId));
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
  } catch (error) {
    failed++;
    const capture = await captureTriage("FAIL-" + name, { error: String(error.message || error) }).catch(() => null);
    console.error("  ✗ " + name + "\n      " + (error.message || error) + (capture ? "\n      evidence: " + capture.json : ""));
  }
}

const work = mkdtempSync(join(tmpdir(), "ofm-todo-sync-"));
const userData = mkdtempSync(join(tmpdir(), "fm-p-"));
mkdirSync(join(userData, "User"), { recursive: true });
writeFileSync(
  join(userData, "User", "settings.json"),
  JSON.stringify({
    "workbench.editorAssociations": { "*.md": "ofm.livePreview" },
    "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none",
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "window.commandCenter": false,
  })
);

const alphaPath = join(work, "alpha.md");
const betaPath = join(work, "beta.md");
const emptyPath = join(work, "empty.md");
const coldPath = join(work, "cold.md");
writeFileSync(
  alphaPath,
  "# Alpha\n\n- [ ] alpha open\n- [x] alpha done\n- [/] alpha active\n\nalpha tail\n"
);
writeFileSync(betaPath, "# Beta\n\n- [?] beta question\n");
writeFileSync(emptyPath, "# Empty\n\nNo tasks here.\n");
writeFileSync(
  coldPath,
  "# Cold navigation\n\n" +
    Array.from({ length: 80 }, (_, index) => `filler line ${index}`).join("\n") +
    "\n\n- [ ] cold target\n"
);
writeFileSync(join(work, "plain.txt"), "not markdown\n");

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
    alphaPath,
  ],
});

try {
  const win = await adaptWindow(await app.firstWindow(),app);
  activeWin = win;
  await win.waitForSelector(".monaco-workbench", { timeout: 30000 });
  await win.waitForTimeout(4500);
  const palette = (combo, text) =>
    openPalette(win, combo, text, { waitBeforeEnter: 900, waitAfterEnter: 1200 });

  async function findCmFrameContaining(text, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const frame of win.frames()) {
        try {
          const content = frame.locator(".cm-content").first();
          if (
            (await content.count()) > 0 &&
            (await content.isVisible()) && await isVisibleFrame(frame) &&
            (await content.innerText()).includes(text)
          ) {
            return frame;
          }
        } catch {
          // Ignore transient/cross-origin frames while tabs switch.
        }
      }
      await win.waitForTimeout(250);
    }
    return null;
  }

  async function openFlintmark() {
    if(IS_CURSOR){await palette("F1",">View: Show Flintmark");return;}
    const visible = await win
      .locator(".pane")
      .filter({ hasText: /Backlinks/i })
      .first()
      .isVisible()
      .catch(() => false);
    if (visible) return;
    const icon = win.locator('.activitybar a[aria-label*="Flintmark"]').first();
    await icon.waitFor({ state: "visible", timeout: 8000 });
    await icon.click();
    await win.waitForTimeout(800);
  }

  const todoPane = () => win.locator(".pane").filter({ hasText: /Todo/i }).first();
  const todoRows = () => todoPane().locator(".monaco-list-row");

  async function waitTodoRows(predicate, description, timeout = 10000) {
    const deadline = Date.now() + timeout;
    let texts = [];
    while (Date.now() < deadline) {
      texts = await todoRows().allInnerTexts().catch(() => []);
      if (predicate(texts)) return texts;
      await win.waitForTimeout(150);
    }
    throw new Error(`${description}; Todo rows were ${JSON.stringify(texts)}`);
  }

  const hasRow = (texts, label) => texts.some((text) => text.includes(label));
  const rowFor = (label) => todoRows().filter({ hasText: label }).first();

  async function selectionLine(frame) {
    return frame.evaluate(() => {
      const selection = window.getSelection();
      let node = selection && selection.focusNode;
      while (node && node.nodeType !== 1) node = node.parentElement;
      const line = node ? node.closest(".cm-line") : null;
      return line ? line.textContent || "" : "(none)";
    });
  }

  async function clickEditorAction(label, waitAfterClick = 1200) {
    if(IS_CURSOR){await palette("F1",">Flintmark: Switch to "+label);return;}
    const action = win.locator(`.editor-actions [aria-label*="${label}"]`).first();
    await action.waitFor({ state: "visible", timeout: 8000 });
    await action.click();
    await win.waitForTimeout(waitAfterClick);
  }

  await palette("Control+P", "alpha.md");
  let alphaFrame = await findCmFrameContaining("alpha tail");
  if (!alphaFrame) {
    const initial = await captureTriage("alpha-initial-open-failure", { file: "alpha.md" });
    let repaired = false;
    let repairError = null;
    try {
      await palette("F1", ">Flintmark: Switch to Live View");
      await win.waitForTimeout(1500);
      alphaFrame = await findCmFrameContaining("alpha tail", 8000);
      repaired = !!alphaFrame;
    } catch (error) {
      repairError = String(error.message || error);
    }
    const after = await captureTriage("alpha-after-switch-to-live", { initialEvidence: initial?.json, repaired, repairError });
    assert.fail(`alpha.md did not open in Live Preview on initial open; explicit Switch to Live View repaired=${repaired}; repairError=${repairError}; initialEvidence=${initial?.json}; afterEvidence=${after?.json}`);
  }
  await openFlintmark();

  await test("panel order is Outline → Todo → Backlinks", async () => {
    const headers = await win.locator(".pane-header").allInnerTexts();
    const outline = headers.findIndex((text) => /Outline/i.test(text));
    const todo = headers.findIndex((text) => /^\s*Todo\b/i.test(text));
    const backlinks = headers.findIndex((text) => /Backlinks/i.test(text));
    assert.ok(
      outline >= 0 && outline < todo && todo < backlinks,
      `unexpected pane order: ${JSON.stringify(headers)}`
    );
  });

  await test("aggregates all statuses in document order", async () => {
    const texts = await waitTodoRows(
      (rows) => ["alpha open", "alpha done", "alpha active"].every((x) => hasRow(rows, x)),
      "alpha tasks should appear"
    );
    const labels = texts.filter((text) => /alpha (open|done|active)/.test(text));
    assert.deepEqual(
      labels.map((text) => /alpha (open|done|active)/.exec(text)?.[1]),
      ["open", "done", "active"]
    );
    assert.ok(labels[0].includes("[ ]"), labels[0]);
    assert.ok(labels[1].includes("[x]"), labels[1]);
    assert.ok(labels[2].includes("[/]"), labels[2]);
  });

  await test("checkbox changes and undo/redo stay synchronized", async () => {
    await rowFor("alpha open").click();
    await win.waitForTimeout(500);
    assert.ok((await selectionLine(alphaFrame)).includes("alpha open"));
    const checkbox = alphaFrame
      .locator(".cm-line", { hasText: "alpha open" })
      .locator("input.ofm-task-checkbox")
      .first();
    await checkbox.click();
    await waitTodoRows(
      (rows) => rows.some((text) => text.includes("alpha open") && text.includes("[x]")),
      "checkbox toggle should update Todo"
    );
    await win.keyboard.press("Control+z");
    await waitTodoRows(
      (rows) => rows.some((text) => text.includes("alpha open") && text.includes("[ ]")),
      "undo should restore unchecked Todo"
    );
    await win.keyboard.press("Control+y");
    await waitTodoRows(
      (rows) => rows.some((text) => text.includes("alpha open") && text.includes("[x]")),
      "redo should restore checked Todo"
    );
  });

  await test("label edits plus undo and redo never leave stale rows", async () => {
    await rowFor("alpha active").click();
    await win.waitForTimeout(400);
    assert.ok((await selectionLine(alphaFrame)).includes("alpha active"));
    const focusDeadline=Date.now()+5000;
    while (!(await alphaFrame.evaluate(()=>document.querySelector('.cm-content').cmTile.root.view.hasFocus)) && Date.now()<focusDeadline) await win.waitForTimeout(25);
    const inputState=()=>alphaFrame.evaluate(()=>{const v=document.querySelector('.cm-content').cmTile.root.view;return {text:v.state.doc.toString(),selection:v.state.selection.main,cmFocused:v.hasFocus,documentFocused:document.hasFocus(),active:document.activeElement?.className};});
    console.log('TODO_INPUT_BEFORE_END',JSON.stringify(await inputState()));
    assert.ok((await inputState()).cmFocused,'Todo navigation must focus the editor before typing');
    await win.keyboard.press("End");
    console.log('TODO_INPUT_AFTER_END',JSON.stringify(await inputState()));
    // One input transaction has one unambiguous undo unit on every host.
    await win.keyboard.insertText(" renamed");
    console.log("TODO_INPUT_AFTER_INSERT",JSON.stringify(await inputState()));
    await waitTodoRows(
      (rows) => hasRow(rows, "alpha active renamed"),
      "renamed task should appear"
    );
    await win.keyboard.press("Control+z");
    await waitTodoRows(
      (rows) => rows.some((text) => /^alpha active\s*\[\/\]/.test(text)),
      "undo should restore the old label"
    );
    assert.equal(await alphaFrame.evaluate(() => {
      const view = document.querySelector(".cm-content").cmTile.root.view;
      return view.state.doc.toString().split("\n").find((line) => line.startsWith("- [/] alpha active"));
    }), "- [/] alpha active", "undo must restore the entire task label");
    await win.keyboard.press("Control+y");
    await waitTodoRows(
      (rows) => hasRow(rows, "alpha active renamed"),
      "redo should restore the renamed label"
    );
    await win.keyboard.press("Control+s");
  });

  await test("switching Markdown and non-Markdown tabs never leaks old todos", async () => {
    await palette("Control+P", "beta.md");
    assert.ok(await findCmFrameContaining("beta question"));
    await waitTodoRows(
      (rows) => hasRow(rows, "beta question") && !rows.some((text) => /alpha /.test(text)),
      "Beta should replace Alpha rows"
    );

    await palette("Control+P", "empty.md");
    assert.ok(await findCmFrameContaining("No tasks here"));
    await waitTodoRows(
      (rows) => rows.some((text) => /No todos/i.test(text)),
      "empty Markdown should show No todos"
    );

    await palette("Control+P", "plain.txt");
    await win.locator(".monaco-editor .view-lines").first().waitFor({ state: "visible", timeout: 8000 });
    await waitTodoRows(
      (rows) => rows.some((text) => /Open a Markdown note/i.test(text)),
      "non-Markdown tab should show the placeholder"
    );

    await palette("Control+P", "alpha.md");
    alphaFrame = await findCmFrameContaining("alpha tail");
    assert.ok(alphaFrame);
    await waitTodoRows(
      (rows) => hasRow(rows, "alpha open") && !hasRow(rows, "beta question"),
      "returning to Alpha should restore only Alpha rows"
    );
  });

  await test("source-editor edits and undo/redo update the open Todo panel", async () => {
    await clickEditorAction("Code View");
    const source = win.locator(".monaco-editor .view-lines").first();
    await source.waitFor({ state: "visible", timeout: 8000 });
    await source.click();
    await win.keyboard.press("Control+End");
    await win.keyboard.press("Enter");
    await win.keyboard.insertText("- [>] source-added");
    await waitTodoRows(
      (rows) => hasRow(rows, "source-added"),
      "source edit should add a Todo row"
    );
    await win.keyboard.press("Control+z");
    await waitTodoRows(
      (rows) => !hasRow(rows, "source-added"),
      "source undo should remove the Todo row"
    );
    await win.keyboard.press("Control+Shift+z");
    await waitTodoRows(
      (rows) => hasRow(rows, "source-added"),
      "source redo should restore the Todo row"
    );
    await win.keyboard.press("Control+s");
    await win.waitForTimeout(600);
  });

  await test("external full-file updates add and remove Todo rows", async () => {
    const baseline = readFileSync(alphaPath, "utf8");
    const withoutDone = baseline.replace(/^- \[[xX]\] alpha done\r?\n/m, "");
    assert.notEqual(withoutDone, baseline, "fixture should contain alpha done");
    writeFileSync(alphaPath, withoutDone);
    await waitTodoRows(
      (rows) => !hasRow(rows, "alpha done"),
      "external deletion should remove an existing Todo row",
      12000
    );
    writeFileSync(alphaPath, baseline);
    await waitTodoRows(
      (rows) => hasRow(rows, "alpha done"),
      "restoring the file should restore the deleted Todo row",
      12000
    );

    writeFileSync(alphaPath, baseline + "\n- [-] external-added\n");
    await waitTodoRows(
      (rows) => hasRow(rows, "external-added"),
      "external write should add a Todo row",
      12000
    );
    writeFileSync(alphaPath, baseline);
    await waitTodoRows(
      (rows) => !hasRow(rows, "external-added") && hasRow(rows, "source-added"),
      "external replacement should remove only the external row",
      12000
    );
  });

  await test("source-only Todo navigation opens Live Preview and lands after init", async () => {
    await palette("Control+P", "cold.md");
    const coldLive = await findCmFrameContaining("Cold navigation");
    assert.ok(coldLive, "cold.md should first open in Live Preview");
    await clickEditorAction("Code View");
    await win.locator(".monaco-editor .view-lines").first().waitFor({ state: "visible", timeout: 8000 });
    await waitTodoRows(
      (rows) => hasRow(rows, "cold target"),
      "source-only Cold document should populate Todo"
    );
    await rowFor("cold target").click();
    // Navigation scrolls the late target into the rendered viewport, so select
    // the matching frame by that text (other retained webviews may also report
    // themselves visible to Playwright).
    const reopened = await findCmFrameContaining("cold target", 12000);
    if (!reopened) {
      const tabs = await win.locator(".tab").allInnerTexts().catch(() => []);
      const frames = [];
      for (const frame of win.frames()) {
        try {
          const content = frame.locator(".cm-content").first();
          if ((await content.count()) > 0) {
            frames.push({
              visible: await content.isVisible(),
              text: (await content.innerText()).slice(0, 120),
              selection: await selectionLine(frame),
            });
          }
        } catch {
          // Diagnostic only.
        }
      }
      assert.fail(
        `Todo click should reopen Cold in Live Preview; tabs=${JSON.stringify(tabs)} frames=${JSON.stringify(frames)}`
      );
    }
    const deadline = Date.now() + 8000;
    let line = "";
    while (Date.now() < deadline) {
      line = await selectionLine(reopened);
      if (line.includes("cold target")) break;
      await win.waitForTimeout(200);
    }
    assert.ok(
      line.includes("cold target"),
      `queued reveal should land on the target after init, got ${JSON.stringify(line)}`
    );
  });
} finally {
  if (failed) await captureTriage("todo-final-failures", { failed, total }).catch(() => null);
  await app.close();
}

if (failed > 0) {
  console.error(`\n${failed}/${total} Todo reliability E2E test(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll ${total} Todo reliability E2E tests passed`);

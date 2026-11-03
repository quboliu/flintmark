// Test-only external-writer adaptation of structure-final/harness/workspace-registered.mjs.
// The 25 ms root create/unlink loop runs in an owned Node child, not the Playwright parent.
// The GUI, gate-held assertions, exact click, selection/editor-instance/autocomplete checks,
// and the original thresholds are unchanged. Cleanup is part of pass/fail.

import {createRequire} from 'node:module';
const require=createRequire(process.env.FLINTMARK_DEPS+'/package.json');
const{_electron:electron}=require('playwright');
import {mkdtempSync,mkdirSync,unlinkSync,writeFileSync,readdirSync,existsSync,lstatSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {fork,spawnSync} from "node:child_process";
import assert from "node:assert";
import {performance} from "node:perf_hooks";

const REPO = process.env.FLINTMARK_REPO || resolve(".");
const VSCODE = process.env.VSCODE_BIN || "/usr/share/codium/codium";
const OUT = process.env.FLINTMARK_OUT;
assert.ok(OUT, "FLINTMARK_OUT is required for evidence");
mkdirSync(OUT, { recursive: true });

const noiseEnabled = Boolean(process.env.FLINTMARK_STRESS_NOISE);
const noisePrefix = `ofm-noise-${process.pid}-`;
const writerPath = fileURLToPath(new URL("./writer-child.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withDiagnosticTimeout(label, operation, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  return Promise.race([Promise.resolve().then(operation), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

const WRITER_READY_TIMEOUT_MS = 10000;
const WRITER_SNAPSHOT_TIMEOUT_MS = 5000;
const WRITER_STOP_TIMEOUT_MS = 5000;
const WRITER_EXIT_TIMEOUT_MS = 5000;
const DIAGNOSTIC_TIMEOUT_MS = 5000;

// Historical local investigation scheduling is not part of this portable test.
const work = mkdtempSync(join(tmpdir(), "ofm-vault-ready-"));
const userData = mkdtempSync(join(tmpdir(), "fm-p-"));
const buildGate = join(work, "vault-build.gate");
writeFileSync(buildGate, "held");
mkdirSync(join(userData, "User"), { recursive: true });
writeFileSync(
  join(userData, "User", "settings.json"),
  JSON.stringify({
    "workbench.editorAssociations": { "*.md": "ofm.livePreview" },
    "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none",
    "telemetry.telemetryLevel": "off",
    "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false,
    "chat.disableAIFeatures": true,
    "update.mode": "none",
    "window.commandCenter": false,
  })
);

const openPath = join(work, "open.md");
writeFileSync(openPath, "# Ready lifecycle\n\nselection-probe\n");
writeFileSync(join(work, "Late Vault Target.md"), "# Late Vault Target\n");
const links = Array.from({ length: 120 }, (_, i) => `[[Synthetic-${i % 37}]]`).join(" ");
const noteCount = Number(process.env.FLINTMARK_STRESS_FILES) || 20_000;
for (let i = 0; i < noteCount; i++) {
  writeFileSync(join(work, `Synthetic-${i}.md`), `# Synthetic ${i}\n\n#tag-${i % 41} ${links}\n`);
}

const imageCount = Number(process.env.FLINTMARK_STRESS_IMAGES) || 4_200;
if (imageCount) {
  mkdirSync(join(work, "images"));
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  for (let i = 0; i < imageCount; i++) writeFileSync(join(work, "images", "image-" + i + ".png"), pixel);
}

console.log("FIXTURE_READY", JSON.stringify({work, noteCount, imageCount, noiseEnabled, noisePrefix}));
const stressStarted = performance.now();

let writer = null;
const writerMessages = [];
let writerExit = null;
let writerError = null;
let writerStderr = "";

function recordWriterMessage(message) {
  if (!message || typeof message !== "object") return;
  writerMessages.push(message);
  if (message.type === "worker-error") {
    writerError = "worker-error: " + JSON.stringify(message.errors ?? message);
  }
}

function childExitSnapshot(child) {
  if (!child) return null;
  return child.exitCode !== null || child.signalCode !== null
    ? {code: child.exitCode, signal: child.signalCode}
    : null;
}

function waitForChildExit(child, timeoutMs) {
  const known = childExitSnapshot(child);
  if (known || !child) return Promise.resolve(known);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(value);
    };
    const onExit = (code, signal) => finish({code, signal});
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.once("exit", onExit);
  });
}

function killOwned(child) {
  if (!child) return;
  try {
    if (process.platform === "win32" && child.pid) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {stdio: "ignore", timeout: 10000});
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // The exit wait below records whether termination was actually observed.
  }
}

async function waitForWriterMessage(type, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const message = writerMessages.find((entry) => entry.type === type);
    if (message) return message;
    if (writerError) throw new Error(writerError);
    if (writerExit) throw new Error(`writer exited before ${type}: ${JSON.stringify(writerExit)}`);
    await sleep(25);
  }
  throw new Error(`writer ${type} timed out after ${timeoutMs}ms`);
}

async function startWriter() {
  writer = fork(writerPath, [], {
    // Keep the standalone writer free of parent preloads (Windows readiness and
    // installed-candidate wrappers) and Playwright/editor bootstrap arguments.
    execArgv: [],
    env: {
      ...process.env,
      FLINTMARK_NOISE_FIXTURE: work,
      FLINTMARK_NOISE_PREFIX: noisePrefix,
      FLINTMARK_NOISE_INTERVAL_MS: "25",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  writer.on("message", recordWriterMessage);
  writer.on("error", (error) => {
    writerError = "writer process error: " + String(error);
  });
  writer.on("exit", (code, signal) => {
    writerExit = {code, signal};
  });
  writer.stderr.on("data", (data) => {
    writerStderr += String(data);
  });
  return await waitForWriterMessage("ready", WRITER_READY_TIMEOUT_MS);
}

async function requestWriterSnapshot() {
  if (!writer || !writer.connected) throw new Error("writer is not connected");
  writer.send({type: "snapshot"});
  return await waitForWriterMessage("snapshot", WRITER_SNAPSHOT_TIMEOUT_MS);
}

async function stopWriter() {
  const result = {
    state: "not-started",
    report: null,
    exit: childExitSnapshot(writer),
    error: null,
  };
  if (!writer) return result;
  if (result.exit) {
    result.state = "already-exited";
    result.report = [...writerMessages].reverse().find((entry) =>
      entry.type === "stopped" || entry.type === "snapshot" || entry.type === "worker-error"
    ) ?? null;
    return result;
  }

  try {
    if (writer.connected) writer.send({type: "stop"});
  } catch (error) {
    result.error = String(error);
  }
  try {
    result.report = await waitForWriterMessage("stopped", WRITER_STOP_TIMEOUT_MS);
    result.state = "stopped";
  } catch (error) {
    result.error = result.error || String(error);
    result.state = "stop-failed";
  }

  result.exit = await waitForChildExit(writer, WRITER_EXIT_TIMEOUT_MS);
  if (!result.exit) {
    killOwned(writer);
    result.exit = await waitForChildExit(writer, WRITER_EXIT_TIMEOUT_MS);
    result.state = "killed";
  }
  if (!result.report) {
    result.report = [...writerMessages].reverse().find((entry) =>
      entry.type === "stopped" || entry.type === "snapshot" || entry.type === "worker-error"
    ) ?? null;
  }
  return result;
}

function cleanupNoisePrefix() {
  const result = {removed: 0, errors: [], skipped: false};
  if (!noiseEnabled) return result;
  let names;
  try {
    names = readdirSync(work);
  } catch (error) {
    result.errors.push(String(error));
    return result;
  }
  for (const name of names) {
    if (!name.startsWith(noisePrefix)) continue;
    const file = join(work, name);
    try {
      if (!lstatSync(file).isFile()) {
        result.errors.push("prefix entry is not a regular file: " + name);
        continue;
      }
      unlinkSync(file);
      result.removed++;
    } catch (error) {
      result.errors.push(String(error));
    }
  }
  return result;
}

let app = null;
async function launchApp() {
  return await electron.launch({
    executablePath: VSCODE,
    env: { ...process.env, FLINTMARK_TEST_VAULT_BUILD_GATE: buildGate },
    args: [...(/cursor/i.test(process.env.VSCODE_BIN||'')?['--skip-onboarding']:[]),
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--user-data-dir=${userData}`,
      `--extensions-dir=${join(work, "ext")}`,
      `--extensionDevelopmentPath=${REPO}`,
      work,
      openPath,
    ],
  });
}

async function findCmFrame(win, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    for (const frame of win.frames()) {
      try {
        const content = frame.locator(".cm-content").first();
        if ((await content.count()) > 0 && (await content.isVisible())) return frame;
      } catch {
        /* cross-origin */
      }
    }
    await win.waitForTimeout(25);
  }
  return null;
}

async function autocompleteOptions(cm, win) {
  const line = cm.locator(".cm-line", { hasText: "selection-probe" }).first();
  await line.click();
  await cm.evaluate(()=>{const e=document.querySelector('.cm-content');const v=e.cmTile?.root?.view||e.cmView?.view||e.parentElement.cmView?.view;const at=v.state.doc.toString().indexOf('selection-probe');v.dispatch({selection:{anchor:v.state.doc.lineAt(at).to}});v.focus();});
  await win.keyboard.type(" [[Late");
  await win.waitForTimeout(250);
  return await cm.locator(".cm-tooltip-autocomplete li").allInnerTexts();
}

async function reopenWithFlintmark(win) {
  await win.bringToFront();
  await win.keyboard.press("Escape").catch(() => {});
  await win.keyboard.press("F1");
  const widget = win.locator(".quick-input-widget");
  await widget.waitFor({ state: "visible", timeout: 10000 });
  const input = widget.locator("input:not([type=checkbox])").first();
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.fill(">Reopen Editor With");
  const command = widget
    .locator(".monaco-list-row")
    .filter({ hasText: /Reopen Editor With/ })
    .first();
  await command.waitFor({ state: "visible", timeout: 30000 });
  await command.click();
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.fill("Flintmark");
  const choice = widget
    .locator(".monaco-list-row")
    .filter({ hasText: /Flintmark|Markdown Live Preview/ })
    .first();
  await choice.waitFor({ state: "visible", timeout: 30000 });
  await choice.click();
}

let bodyPassed = false;
let bodyError = null;
const diagnosticErrors = [];
let coldPaintMs = null;
let writerReadyReport = null;
let writerSnapshotReport = null;
let writerStopResult = null;
let writerStopError = null;
let leftoverCleanup = {removed: 0, errors: [], skipped: false};
let gateRemoved = false;
let appCloseState = "not-started";
let ownedProcessTerminated = false;

try {
  if (!noiseEnabled) {
    throw new Error("FLINTMARK_STRESS_NOISE is required for the external-writer stress test");
  }
  writerReadyReport = await startWriter();
  console.log("WRITER_READY", JSON.stringify({
    pid: writerReadyReport.pid,
    prefix: writerReadyReport.prefix,
    intervalMs: writerReadyReport.intervalMs,
    runMs: writerReadyReport.runMs,
  }));

  app = await launchApp();
  const win = await app.firstWindow();await win.waitForSelector('.monaco-workbench',{timeout:120000});const welcome=win.locator('.antigravity-ide-welcome-button');if(await welcome.isVisible()){await welcome.click();await win.waitForTimeout(1500);}
  await win.waitForSelector(".monaco-workbench", { timeout: 30000 });
  // Observe a cold Windows launch without racing its extension-host startup
  // with command-palette actions. The vault gate remains held throughout.
  let cm = await findCmFrame(win, process.platform === "win32" ? 180000 : 500);
  for (let attempt = 0; attempt < 3 && !cm && process.platform !== "win32"; attempt++) {
    try {
      await reopenWithFlintmark(win);
      cm = await findCmFrame(win, 10000);
    } catch {
      await win.keyboard.press("Escape").catch(() => {});
    }
    if (!cm) await win.waitForTimeout(2500);
  }
  assert.ok(cm, "open.md should paint in Flintmark while the vault build runs");
  const nativeWindows = await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().filter(w=>!w.isDestroyed()).map(w=>({bounds:w.getBounds(),visible:w.isVisible(),minimized:w.isMinimized(),focused:w.isFocused()})));
  const rendererState = await win.evaluate(()=>({width:innerWidth,height:innerHeight,hidden:document.hidden,visibility:document.visibilityState,focused:document.hasFocus()}));
  const clickTarget = await cm.locator('.cm-line').filter({hasText:'selection-probe'}).first().boundingBox();
  writeFileSync(join(OUT,'pre-click-window-state.json'),JSON.stringify({nativeWindows,rendererState,clickTarget},null,2));
  console.log('PRE_CLICK_WINDOW_STATE',JSON.stringify({nativeWindows,rendererState,clickTarget}));
  coldPaintMs = performance.now() - stressStarted;
  console.log("COLD_PAINT", JSON.stringify({coldPaintMs, platform:process.platform, automatic:false, startupMode:"post-activation-standard-open"}));

  await cm.locator(".cm-editor").evaluate((el) => {
    el.dataset.vaultReadyInstance = "original";
  });
  const gatedOptions = await autocompleteOptions(cm, win);
  assert.equal(
    gatedOptions.some((text) => text.includes("Late Vault Target")),
    false,
    `the editor must be interactive before gated VaultData publication: ${JSON.stringify(gatedOptions)}`
  );

  await win.keyboard.press("Escape");
  for (let i = 0; i < 7; i++) await win.keyboard.press("Backspace");
  unlinkSync(buildGate);

  let eventualOptions = [];
  const deadline = performance.now() + 120000;
  while (performance.now() < deadline) {
    eventualOptions = await autocompleteOptions(cm, win);
    if (eventualOptions.some((text) => text.includes("Late Vault Target"))) break;
    await win.keyboard.press("Escape");
    for (let i = 0; i < 7; i++) await win.keyboard.press("Backspace");
    await win.waitForTimeout(400);
  }

  assert.ok(
    eventualOptions.some((text) => text.includes("Late Vault Target")),
    `published VaultData should eventually reach the existing editor: ${JSON.stringify(eventualOptions)}`
  );
  const state = await cm.evaluate(() => ({
    token: document.querySelector(".cm-editor")?.dataset.vaultReadyInstance,
    activeText: (() => {
      let node = window.getSelection()?.focusNode ?? null;
      while (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentNode;
      return node?.closest?.(".cm-line")?.textContent ?? "";
    })(),
    editorCount: document.querySelectorAll(".cm-editor").length,
  }));
  assert.equal(state.token, "original", "VaultData push must not rebuild the EditorView DOM");
  assert.equal(state.editorCount, 1, "only one editor instance should remain");
  assert.ok(state.activeText.includes("selection-probe"), "the active selection line must be retained");
  console.log("  ✓ body paints before VaultData; later data preserves editor instance and selection");

  writerSnapshotReport = await requestWriterSnapshot();
  console.log("WRITER_SNAPSHOT", JSON.stringify({
    operations: writerSnapshotReport.operations,
    attempts: writerSnapshotReport.attempts,
    errors: writerSnapshotReport.errors,
    maxOpMs: writerSnapshotReport.maxOpMs,
  }));
  await win.screenshot({path:join(OUT,"workspace-stress.png")});
  bodyPassed = true;
} catch(error) {
  bodyError = String(error?.stack || error);
  process.exitCode = 1;

  // Failure diagnostics share one explicit budget so a stuck renderer cannot
  // delay the finally block that stops the owned writer and editor. Diagnostic
  // failures are recorded separately and never replace the original bodyError.
  const diagnosticDeadline = performance.now() + DIAGNOSTIC_TIMEOUT_MS;
  let failureBodyText = "";
  if (app) {
    let windows = [];
    try {
      windows = app.windows();
    } catch (diagnosticError) {
      diagnosticErrors.push("enumerate windows: " + String(diagnosticError?.message || diagnosticError));
    }
    for (const w of windows) {
      let budget = Math.max(1, Math.ceil(diagnosticDeadline - performance.now()));
      try {
        await withDiagnosticTimeout(
          "failure screenshot",
          () => w.screenshot({ path: join(OUT, "workspace-failure.png"), timeout: budget }),
          budget
        );
      } catch (diagnosticError) {
        diagnosticErrors.push("screenshot: " + String(diagnosticError?.message || diagnosticError));
      }
      budget = Math.max(1, Math.ceil(diagnosticDeadline - performance.now()));
      try {
        failureBodyText = await withDiagnosticTimeout(
          "failure body text",
          () => w.locator("body").innerText({ timeout: budget }),
          budget
        );
      } catch (diagnosticError) {
        diagnosticErrors.push("body text: " + String(diagnosticError?.message || diagnosticError));
      }
    }
  }
  const diagnosticText = diagnosticErrors.length
    ? `\n\nDIAGNOSTIC ERRORS (${DIAGNOSTIC_TIMEOUT_MS}ms budget):\n${diagnosticErrors.join("\n")}\n`
    : "";
  try {
    writeFileSync(
      join(OUT, "workspace-failure.txt"),
      bodyError + "\n" + (failureBodyText ? "\n" + failureBodyText : "") + diagnosticText
    );
  } catch (diagnosticError) {
    diagnosticErrors.push("write failure text: " + String(diagnosticError?.message || diagnosticError));
  }
} finally {
  try {
    writerStopResult = await stopWriter();
    if (writerStopResult.error) writerStopError = writerStopResult.error;
  } catch (error) {
    writerStopError = String(error?.stack || error);
  }

  // Stop the writer first. Remove only files carrying this run's unique prefix,
  // and only after writer exit is actually observed.
  try {
    if (noiseEnabled) {
      const exitKnown = Boolean(writerStopResult?.exit || writerExit);
      if (exitKnown) {
        leftoverCleanup = cleanupNoisePrefix();
      } else {
        leftoverCleanup = {removed: 0, errors: [], skipped: true};
      }
    }
  } catch (error) {
    leftoverCleanup.errors.push(String(error));
  }

  try {
    if (existsSync(buildGate)) unlinkSync(buildGate);
    gateRemoved = true;
  } catch (error) {
    leftoverCleanup.errors.push("gate cleanup: " + String(error));
  }

  if (app) {
    const child = app.process();
    appCloseState = await Promise.race([
      app.close().then(() => "closed", (error) => "error:" + String(error)),
      sleep(15000).then(() => "timeout"),
    ]);
    if (appCloseState === "closed") {
      const end = performance.now() + 5000;
      while (child?.exitCode === null && child?.signalCode === null && performance.now() < end) await sleep(100);
      if (child?.exitCode === null && child?.signalCode === null) {
        appCloseState = "close-returned-with-live-process";
      }
    }
    if (appCloseState !== "closed") {
      killOwned(child);
      const end = performance.now() + 5000;
      while (child?.exitCode === null && child?.signalCode === null && performance.now() < end) await sleep(100);
      process.exitCode = 1;
    }
    ownedProcessTerminated = !child || child.exitCode !== null || child.signalCode !== null;
    if (!ownedProcessTerminated) process.exitCode = 1;
  } else {
    appCloseState = "not-started";
    ownedProcessTerminated = true;
  }

  const writerReport = writerStopResult?.report || writerSnapshotReport || writerReadyReport;
  const writerErrors = [
    ...(writerReport?.errors || []),
    ...(writerStopError ? [writerStopError] : []),
    ...(writerError ? [writerError] : []),
  ];
  const writerOperations = writerReport?.operations ?? 0;
  const writerExitOk = writerStopResult?.exit && writerStopResult.exit.code === 0;
  const writerOk = noiseEnabled &&
    Boolean(writerReadyReport) &&
    Boolean(writerSnapshotReport) &&
    writerStopResult?.state === "stopped" &&
    Boolean(writerExitOk) &&
    writerOperations >= 100 &&
    writerErrors.length === 0 &&
    !writerStderr.trim();
  const appOk = !app || (appCloseState === "closed" && ownedProcessTerminated);
  const cleanupOk = writerOk &&
    !leftoverCleanup.skipped &&
    leftoverCleanup.errors.length === 0 &&
    gateRemoved &&
    appOk;
  const passed = Boolean(bodyPassed && !bodyError && cleanupOk);
  if (!passed) process.exitCode = 1;

  const result = {
    platform: process.platform,
    notes: noteCount,
    images: imageCount,
    tempFilesCreatedAndDeleted: writerOperations,
    writerAttempts: writerReport?.attempts ?? 0,
    writerErrors,
    durationMs: performance.now() - stressStarted,
    passed,
    bodyBeforeIndex: bodyPassed,
    startupMode: "post-activation-standard-open",
    automaticAssociationNotAsserted: true,
    work,
    coldPaintMs,
    noisePrefix,
    writer: {
      enabled: noiseEnabled,
      intervalMs: writerReport?.intervalMs ?? 25,
      timeouts: {
        readyMs: WRITER_READY_TIMEOUT_MS,
        snapshotMs: WRITER_SNAPSHOT_TIMEOUT_MS,
        stopMs: WRITER_STOP_TIMEOUT_MS,
        exitMs: WRITER_EXIT_TIMEOUT_MS,
      },
      ready: writerReadyReport,
      snapshot: writerSnapshotReport,
      stop: writerStopResult,
      error: writerError,
      stderr: writerStderr,
    },
    cleanup: {
      writerOk,
      leftover: leftoverCleanup,
      gateRemoved,
      appCloseState,
      ownedProcessTerminated,
    },
    diagnosticTimeoutMs: DIAGNOSTIC_TIMEOUT_MS,
    diagnosticErrors,
    error: bodyError,
  };
  writeFileSync(join(OUT, "workspace-stress.json"), JSON.stringify(result, null, 2) + "\n");
}

process.exit(process.exitCode || 0);

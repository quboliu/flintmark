// TEST-ONLY single-session corpus lifecycle/stress harness.
//
// One isolated profile, one readiness-gated editor launch, then every selected
// fixture is opened and closed through normal UI in the same workspace. This is
// deliberately NOT a cold-start measurement or a cold-start fix.
//
// Run with the same environment as harness/run-corpus.cjs and with the deployed
// readiness gate:
//   node --require <release>/harness/windows-readiness.cjs <this-file>
//
// Required env: FLINTMARK_REPO, FLINTMARK_DEPS, FLINTMARK_CORPUS,
//               FLINTMARK_OUT, VSCODE_BIN.
// Use a fresh FLINTMARK_OUT for this run so the preserved per-case cold-start
// results are not overwritten.

import fs from 'node:fs';
import {archiveLogs} from './archive-logs.mjs';
import {performance} from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {adaptWindow} from './native-window.mjs';
import {palette} from './quickInput.mjs';

const deps = process.env.FLINTMARK_DEPS;
const repo = process.env.FLINTMARK_REPO;
const corpus = process.env.FLINTMARK_CORPUS;
const out = process.env.FLINTMARK_OUT;
const executable = process.env.VSCODE_BIN;
for (const [name, value] of Object.entries({
  FLINTMARK_DEPS: deps,
  FLINTMARK_REPO: repo,
  FLINTMARK_CORPUS: corpus,
  FLINTMARK_OUT: out,
  VSCODE_BIN: executable,
})) {
  assert.ok(value, name + ' is required');
}

const require = createRequire(path.join(deps, 'package.json'));
const {_electron: electron} = require('playwright');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sha256Buffer = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const manifest = JSON.parse(fs.readFileSync(path.join(corpus, 'manifest.json'), 'utf8'));
const selected = manifest.filter((m) => m.kind === 'large' || (m.eol === 'CRLF' && m.trailing === false));
assert.equal(selected.length, 14, 'the selected corpus set must remain the 14 established cases');
assert.ok(selected.some((m) => /^large-12MiB-/.test(m.name)), '12 MiB cases must remain selected');

fs.mkdirSync(out, {recursive: true});
const summaryPath = path.join(out, 'corpus-summary.json');
const evidenceRoot = path.join(out, 'corpus');
const previousEvidence = fs.existsSync(evidenceRoot) && fs.readdirSync(evidenceRoot).length > 0;
if ((fs.existsSync(summaryPath) || previousEvidence) && process.env.FLINTMARK_SESSION_ALLOW_OVERWRITE !== '1') {
  throw new Error('FLINTMARK_OUT already contains corpus evidence; use a fresh output directory or set FLINTMARK_SESSION_ALLOW_OVERWRITE=1');
}
fs.mkdirSync(evidenceRoot, {recursive: true});

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-session-'));
const work = path.join(out, 'workspace');
const extensions = path.join(out, 'extensions');
fs.mkdirSync(path.join(profile, 'User'), {recursive: true});
fs.mkdirSync(work, {recursive: true});
fs.mkdirSync(extensions, {recursive: true});

// Exactly the existing corpus-case fixture isolation settings: trusted
// workspace, no update/telemetry traffic, Markdown association, AI disabled.
fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
  'workbench.editorAssociations': {'*.md': 'ofm.livePreview'},
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'chat.disableAIFeatures': true,
  'editor.wordWrap': 'off',
  'window.restoreWindows': 'none',
}));

const createdFiles = new Set();
const readinessAnchor = path.join(work, 'readiness-anchor.md');
fs.writeFileSync(readinessAnchor, '# Readiness anchor\n');
createdFiles.add(readinessAnchor);
const target = path.join(work, 'target.md');
fs.writeFileSync(target, '# Target\n');
createdFiles.add(target);
const pixelSource = path.join(corpus, 'pixel.png');
if (fs.existsSync(pixelSource)) {
  const pixelTarget = path.join(work, 'pixel.png');
  fs.copyFileSync(pixelSource, pixelTarget);
  createdFiles.add(pixelTarget);
}

const readinessPath = path.join(out, 'startup-readiness.jsonl');
const readinessLinesBefore = fs.existsSync(readinessPath)
  ? fs.readFileSync(readinessPath, 'utf8').split(/\r?\n/).filter(Boolean).length
  : 0;
const startup = {
  launchRequestedAt: new Date().toISOString(),
  launchRequestedMs: Date.now(),
  launchRequestedMonotonicMs: performance.now(),
  launchResolvedAt: null,
  launchMs: null,
  workbenchReadyAt: null,
  workbenchMs: null,
  readiness: null,
  coldStartClaim: false,
  note: 'One readiness-gated session launch. Startup is recorded separately and is not evidence that cold-start behavior is fixed.',
};
const runtimeErrors = [];
const results = [];
let app;
let ownedAppProcess = null;
let win;
let cleanupConfirmed = true;
let untitledTabsClosed = 0;
let launchError = null;
let retainedFiles = [];
let appCloseState = 'not-started';
let ownedProcessTerminated = false;
let tabSelectorValidated = false;
const runStartedAt = new Date().toISOString();
const runStarted = performance.now();
const finalizationErrors = [];
let peakWorkingSetBytes = 0;
let lastWorkingSetBytes = 0;

async function cmDocLength(frame) {
  return frame.evaluate(() => {
    const e = document.querySelector('.cm-content');
    const v = e?.cmTile?.root?.view || e?.cmView?.view || e?.parentElement?.cmView?.view;
    return v ? v.state.doc.length : null;
  });
}

async function cmText(frame) {
  return frame.evaluate(() => {
    const e = document.querySelector('.cm-content');
    const v = e?.cmTile?.root?.view || e?.cmView?.view || e?.parentElement?.cmView?.view;
    return v ? v.state.doc.toString() : null;
  });
}

async function sampleMetrics() {
  try {
    const metrics = await app.evaluate(({app}) => app.getAppMetrics());
    const bytes = metrics.reduce((sum, processMetric) => sum + (processMetric.memory?.workingSetSize || 0) * 1024, 0);
    peakWorkingSetBytes = Math.max(peakWorkingSetBytes, bytes);
    lastWorkingSetBytes = bytes;
    return bytes;
  } catch {
    return lastWorkingSetBytes;
  }
}

async function waitForExactEditor(expected, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  let lastLength = null;
  let lastHash = null;
  while (performance.now() < deadline) {
    for (const frame of win.frames()) {
      try {
        const length = await cmDocLength(frame);
        if (length === null) continue;
        lastLength = length;
        if (length !== expected.length) continue;
        const text = await cmText(frame);
        if (text === expected) return frame;
        lastHash = sha256(text);
      } catch {
        // The frame is still attaching.
      }
    }
    await win.waitForTimeout(250);
  }
  const error = new Error(
    'Live Preview did not expose exact initial content ' +
    `(expectedLength=${expected.length}, lastLength=${lastLength}, lastHash=${lastHash || 'none'})`,
  );
  error.code = 'EXACT_EDITOR_TIMEOUT';
  throw error;
}

function quickInputField(widget) {
  const role = widget.getByRole('combobox');
  return role.count().then((count) => count > 0 ? role.first() : widget.locator('input.input[type="text"]').first());
}

async function quickOpen(name) {
  const widget = win.locator('.quick-input-widget');
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    await win.bringToFront().catch(() => {});
    await win.keyboard.press('Escape').catch(() => {});
    await win.waitForTimeout(120);
    await win.keyboard.press(mod + '+P');
    try {
      await widget.waitFor({state: 'visible', timeout: 5000});
      const input = await quickInputField(widget);
      await input.waitFor({state: 'visible', timeout: 3000});
      await input.fill(name);
      await win.waitForTimeout(600);
      const row = widget.locator('.monaco-list-row').filter({hasText: name}).first();
      await row.waitFor({state: 'visible', timeout: 10000});
      await row.click();
      await win.waitForTimeout(500);
      return;
    } catch (error) {
      lastError = error;
      await win.keyboard.press('Escape').catch(() => {});
      await win.waitForTimeout(250);
    }
  }
  throw new Error('Quick Open failed for ' + name + ': ' + String(lastError));
}

async function discardSaveDialog() {
  const dialog = win.locator('.monaco-dialog-box');
  if (!(await dialog.isVisible().catch(() => false))) return false;
  throw new Error('Unexpected save confirmation during tab cleanup; retain the fixture for diagnosis');
}

function isUntitled(label) {
  return /^\s*(?:●\s*)?Untitled(?:-\d+)?\b/.test(label.trim());
}

async function tabLabels() {
  const editorPart = win.locator('#workbench\\.parts\\.editor');
  assert.equal(await editorPart.count(),1,'Editor part must exist for tab cleanup');
  const labels=await editorPart.locator('.tabs-container .tab').allInnerTexts();
  if(labels.length)tabSelectorValidated=true;
  assert.ok(tabSelectorValidated,'Tab selector must have observed the readiness anchor before empty cleanup can pass');
  return labels;
}

async function closeAllEditors() {
  const editorPart = win.locator('#workbench\\.parts\\.editor');
  let untitledClosed = 0;
  for (let pass = 0; pass < 3; pass++) {
    await discardSaveDialog();
    let labels = await tabLabels();
    if (labels.length === 0) return {confirmed: true, untitledClosed};

    if (labels.some((label) => !isUntitled(label))) {
      try {
        await palette(win, 'F1', 'View: Close All Editors', {waitBeforeEnter: 600, waitAfterEnter: 1000});
      } catch {
        // Inspect the tabs rather than trusting the command result.
      }
      await discardSaveDialog();
      await win.waitForTimeout(700);
      labels = await tabLabels();
      if (labels.length === 0) return {confirmed: true, untitledClosed};
      if (labels.some((label) => !isUntitled(label)) && pass === 2) {
        throw new Error('Leftover editor tabs after close-all: ' + JSON.stringify(labels));
      }
      if (labels.some((label) => !isUntitled(label))) continue;
    }

    // An empty Untitled tab created by the host is closed explicitly and is
    // never treated as a fixture result or a test success.
    for (let index = 0; index < labels.length; index++) {
      const tab = editorPart.locator('.tabs-container .tab').filter({hasText: /^Untitled(?:-\d+)?/}).first();
      if (!(await tab.count())) break;
      await tab.click().catch(() => {});
      await win.keyboard.press(mod + '+W').catch(() => {});
      await discardSaveDialog();
      await win.waitForTimeout(300);
      untitledClosed++;
    }
    labels = await tabLabels();
    if (labels.length === 0) return {confirmed: true, untitledClosed};
  }
  throw new Error('Could not confirm all editor tabs closed: ' + JSON.stringify(await tabLabels()));
}

async function openCase(meta, expected) {
  await quickOpen(meta.name);
  return waitForExactEditor(expected, meta.kind === 'large' ? 180000 : 120000);
}

async function readDisk(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return {text, error: null};
  } catch (error) {
    return {text: '', error: String(error)};
  }
}

async function waitForDisk(file, expectedDisk, budgetMs) {
  const started = performance.now();
  const deadline = started + budgetMs;
  let last = {text: '', error: null};
  let readStartedAt = null;
  let readEndedAt = null;
  while (performance.now() < deadline) {
    readStartedAt = performance.now();
    last = await readDisk(file);
    readEndedAt = performance.now();
    if (last.text === expectedDisk) {
      const withinBudget = readEndedAt <= deadline;
      return {
        ok: withinBudget,
        matched: true,
        lateCorrect: !withinBudget,
        ...last,
        budgetMs,
        readStartedAt,
        readEndedAt,
        readStartedMs: readStartedAt - started,
        readEndedMs: readEndedAt - started,
        elapsedMs: readEndedAt - started,
      };
    }
    if (readEndedAt >= deadline) break;
    await sleep(250);
  }
  return {
    ok: false,
    matched: false,
    lateCorrect: false,
    ...last,
    budgetMs,
    readStartedAt,
    readEndedAt,
    readStartedMs: readStartedAt === null ? null : readStartedAt - started,
    readEndedMs: readEndedAt === null ? null : readEndedAt - started,
    elapsedMs: (readEndedAt === null ? performance.now() : readEndedAt) - started,
  };
}

async function runCase(meta) {
  const dir = path.join(evidenceRoot, meta.name);
  fs.mkdirSync(dir, {recursive: true});
  const source = path.join(corpus, meta.name);
  const file = path.join(work, meta.name);
  fs.copyFileSync(source, file);
  createdFiles.add(file);

  const original = fs.readFileSync(source, 'utf8');
  let expected = original.replace(/\r\n/g, '\n');
  const caseStarted = performance.now();
  const errorStart = runtimeErrors.length;
  const result = {
    file: meta.name,
    bytes: meta.bytes,
    meta,
    platform: process.platform,
    arch: process.arch,
    profile,
    passed: false,
    records: [],
    errors: [],
    pageErrors: [],
    tabsClosed: false,
    untitledTabsClosed: 0,
    casePeakWorkingSetBytes: 0,
    durationMs: 0,
    evidence: null,
  };

  try {
    const frame = await openCase(meta, expected);
    await frame.locator('.cm-editor').first().click({trial: true, timeout: 10000});

    const initial = await cmText(frame);
    assert.equal(initial?.length, expected.length, 'Initial editor length');
    assert.equal(sha256(initial), sha256(expected), 'Initial editor content');
    assert.ok((await tabLabels()).length > 0,'Opened fixture must have an observed editor tab');
    result.initialSha256 = sha256(initial);
    result.casePeakWorkingSetBytes = Math.max(result.casePeakWorkingSetBytes, await sampleMetrics());
    await win.screenshot({path: path.join(dir, 'initial.png')});

    for (const place of ['end', 'middle', 'start']) {
      const started = performance.now();
      let at = place === 'end' ? expected.length : place === 'start' ? 0 : Math.floor(expected.length / 2);
      if (place === 'middle' && meta.kind === 'tables') {
        const gap = expected.indexOf('\n\n', at);
        assert.ok(gap >= 0, 'table middle insertion needs a paragraph boundary');
        at = gap + 1;
      }
      if (/[\uDC00-\uDFFF]/.test(expected[at] || '')) at--;

      const token = ' TEST_' + place.toUpperCase() + '_\u{1F680} ';
      await win.bringToFront();
      // Dispatch is used only to place the caret/focus. The edit itself is a
      // real insertText through the UI, never a CodeMirror transaction.
      await frame.evaluate((position) => {
        const e = document.querySelector('.cm-content');
        const v = e?.cmTile?.root?.view || e?.cmView?.view || e?.parentElement?.cmView?.view;
        if (!v) throw new Error('CodeMirror view unavailable');
        v.dispatch({selection: {anchor: position}, scrollIntoView: true});
        v.focus();
      }, at);
      await win.waitForTimeout(300);
      await win.keyboard.insertText(token);
      const insertMs = performance.now() - started;
      expected = expected.slice(0, at) + token + expected.slice(at);

      let screen;
      const screenDeadline = performance.now() + 20000;
      while (performance.now() < screenDeadline) {
        const length = await cmDocLength(frame).catch(() => null);
        if (length === expected.length) {
          screen = await cmText(frame).catch(() => null);
          if (screen === expected) break;
        }
        await win.waitForTimeout(250);
      }
      assert.ok(typeof screen === 'string', 'Visible edit was not observed at ' + place);
      assert.equal(screen.length, expected.length, 'Visible edit length at ' + place);
      assert.equal(sha256(screen), sha256(expected), 'Visible edit differs at ' + place);

      await win.waitForTimeout(1200);
      await win.keyboard.press(mod + '+S');
      const expectedDisk = meta.eol === 'CRLF' ? expected.replace(/\n/g, '\r\n') : expected;
      const saveStarted = performance.now();
      const saved = await waitForDisk(file, expectedDisk, 30000);
      const saveMs = performance.now() - saveStarted;

      if (!saved.ok) {
        const deadlineAt = new Date().toISOString();
        const lateCorrect = saved.lateCorrect === true;
        const deadlineDisk = {text: saved.text, error: saved.error};
        fs.writeFileSync(path.join(dir, 'disk-deadline-read.md'), deadlineDisk.text);
        const deadlineHash = sha256(deadlineDisk.text);
        const deadlineBytes = Buffer.byteLength(deadlineDisk.text);
        let deadlineMtime = null;
        try {
          deadlineMtime = fs.statSync(file).mtime.toISOString();
        } catch {
          // The save may be between rename operations.
        }
        let persistedAt = lateCorrect ? new Date().toISOString() : null;
        let timeToPersistMs = lateCorrect ? saved.elapsedMs : null;
        let observed = deadlineDisk;
        if (!lateCorrect) {
          const observationStart = performance.now();
          while (performance.now() - observationStart < 120000) {
            observed = await readDisk(file);
            if (observed.text === expectedDisk) {
              persistedAt = new Date().toISOString();
              timeToPersistMs = performance.now() - saveStarted;
              break;
            }
            await sleep(250);
          }
        }
        fs.writeFileSync(path.join(dir, 'disk-after-observation.md'), observed.text);
        const diagnosis = {
          place,
          passed: false,
          status: lateCorrect ? 'LATE_CORRECT' : persistedAt ? 'DELAYED_CORRECT' : 'STALE_OR_WRONG',
          matchedInDeadlineRead: saved.matched === true,
          lateCorrect,
          deadlineRead: {
            matched: saved.matched === true,
            withinBudget: saved.ok === true,
            readStartedAt: saved.readStartedAt,
            readEndedAt: saved.readEndedAt,
            readStartedMs: saved.readStartedMs,
            readEndedMs: saved.readEndedMs,
            elapsedMs: saved.elapsedMs,
            budgetMs: saved.budgetMs,
          },
          screenHash: sha256(screen),
          expectedDiskHash: sha256(expectedDisk),
          deadlineAt,
          deadlineHash,
          deadlineBytes,
          deadlineMtime,
          persistedAt,
          timeToPersistMs,
          deadlineElapsedMs: saved.elapsedMs,
          deadlineSnapshot: 'disk-deadline-read.md',
          deadlineSnapshotNote: 'Bytes from the last budgeted read; read completion may be after the deadline. No point-in-time deadline claim.',
          observationSnapshot: 'disk-after-observation.md',
          observationRan: !lateCorrect,
          finalDiskHash: sha256(observed.text),
          finalBytes: Buffer.byteLength(observed.text),
          lastReadError: deadlineDisk.error,
          budgetMs: 30000,
          observationMs: 120000,
          insertMs,
          saveMs,
          latencyMs: performance.now() - started,
        };
        result.records.push(diagnosis);
        fs.writeFileSync(path.join(dir, 'persistence-failure.json'), JSON.stringify(diagnosis, null, 2) + '\n');
        await win.screenshot({path: path.join(dir, 'failure.png')}).catch(() => {});
        throw new Error('Save exceeded the unchanged 30-second polling budget at ' + place + ': ' + diagnosis.status);
      }

      const diskBuffer = fs.readFileSync(file);
      const record = {
        file: meta.name,
        bytes: meta.bytes,
        place,
        passed: true,
        eol: meta.eol,
        screenHash: sha256(screen),
        diskHash: sha256(saved.text),
        expectedDiskHash: sha256(expectedDisk),
        diskBytesSha256: sha256Buffer(diskBuffer),
        bytesOnDisk: diskBuffer.length,
        insertMs,
        saveMs,
        timeToPersistMs: saved.elapsedMs,
        readStartedMs: saved.readStartedMs,
        readEndedMs: saved.readEndedMs,
        budgetMs: saved.budgetMs,
        latencyMs: performance.now() - started,
      };
      result.records.push(record);
      result.casePeakWorkingSetBytes = Math.max(result.casePeakWorkingSetBytes, await sampleMetrics());
      if (place === 'end') await win.screenshot({path: path.join(dir, 'editor.png')});
      if (place === 'start') await win.screenshot({path: path.join(dir, 'final.png')});
    }

    const finalText = await cmText(frame).catch(() => null);
    assert.equal(finalText?.length, expected.length, 'Final full CM length');
    assert.equal(sha256(finalText), sha256(expected), 'Final full CM content');
    result.finalSha256 = sha256(finalText);

    const finalEvidence = path.join(dir, 'final.md');
    fs.copyFileSync(file, finalEvidence);
    const sourceHash = sha256Buffer(fs.readFileSync(file));
    const evidenceHash = sha256Buffer(fs.readFileSync(finalEvidence));
    assert.equal(evidenceHash, sourceHash, 'Evidence copy hash');
    result.evidence = {
      finalFile: finalEvidence,
      sha256: evidenceHash,
      bytes: fs.statSync(finalEvidence).size,
    };
    result.passed = result.records.length === 3 &&
      result.records.every((record) => record.passed) &&
      result.errors.length === 0;
  } catch (error) {
    result.errors.push(String(error?.stack || error));
    await win?.screenshot({path: path.join(dir, 'failure.png')}).catch(() => {});
    await win?.locator('body').innerText()
      .then((text) => fs.writeFileSync(path.join(dir, 'failure.txt'), text))
      .catch(() => {});
    result.passed = false;
  } finally {
    result.pageErrors = runtimeErrors.slice(errorStart);
    if (result.pageErrors.length > 0) result.passed = false;
    result.casePeakWorkingSetBytes = Math.max(result.casePeakWorkingSetBytes, await sampleMetrics());
    try {
      const cleanup = await closeAllEditors();
      result.tabsClosed = cleanup.confirmed;
      result.untitledTabsClosed = cleanup.untitledClosed;
      untitledTabsClosed += cleanup.untitledClosed;
      if (!cleanup.confirmed) {
        result.passed = false;
        result.errors.push('TAB_CLEANUP: all editor tabs were not confirmed closed');
      }
    } catch (error) {
      result.tabsClosed = false;
      result.passed = false;
      result.errors.push('TAB_CLEANUP: ' + String(error?.stack || error));
      await win.screenshot({path:path.join(dir,'cleanup-failure.png')}).catch(()=>{});
      const buffers=[];for(const f of win.frames()){try{const t=await cmText(f);if(typeof t==='string')buffers.push(t);}catch{}}
      fs.writeFileSync(path.join(dir,'cleanup-retained-buffers.json'),JSON.stringify(buffers));
    }

    if (!result.evidence && fs.existsSync(file)) {
      const diskAtFailure = path.join(dir, 'disk-at-failure.md');
      try {
        fs.copyFileSync(file, diskAtFailure);
        result.evidence = {
          finalFile: diskAtFailure,
          sha256: sha256Buffer(fs.readFileSync(diskAtFailure)),
          bytes: fs.statSync(diskAtFailure).size,
          failureObservation: true,
        };
      } catch (error) {
        result.passed=false;
        result.errors.push('EVIDENCE_COPY: ' + String(error?.stack || error));
      }
    }

    if (result.tabsClosed && result.evidence && fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
        createdFiles.delete(file);
      } catch (error) {
        result.passed = false;
        result.errors.push('FIXTURE_REMOVE: ' + String(error?.stack || error));
      }
    } else if (!result.tabsClosed) {
      result.passed = false;
      result.errors.push('FIXTURE_RETAINED: tab cleanup failed; fixture left in workspace');
    }

    result.durationMs = performance.now() - caseStarted;
    result.peakWorkingSetBytes = peakWorkingSetBytes;
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}

try {
  app = await electron.launch({
    executablePath: executable,
    args: [
      ...(/cursor/i.test(executable) ? ['--skip-onboarding'] : []),
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--user-data-dir=' + profile,
      '--extensions-dir=' + extensions,
      '--extensionDevelopmentPath=' + repo,
      work,
      readinessAnchor,
    ],
    timeout: 120000,
  });
  ownedAppProcess = app.process();
  startup.launchResolvedAt = new Date().toISOString();
  startup.launchMs = performance.now() - startup.launchRequestedMonotonicMs;

  win = await app.firstWindow();
  win.on('pageerror', (error) => runtimeErrors.push(String(error)));
  await adaptWindow(win, app);
  startup.workbenchReadyAt = new Date().toISOString();
  startup.workbenchMs = performance.now() - startup.launchRequestedMonotonicMs;

  const readinessLines = fs.existsSync(readinessPath)
    ? fs.readFileSync(readinessPath, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];
  const readiness = readinessLines.length > readinessLinesBefore
    ? JSON.parse(readinessLines[readinessLines.length - 1])
    : null;
  startup.readiness = readiness;
  startup.readinessObservedAt = new Date().toISOString();
  if (!readiness) {
    throw new Error('Readiness gate did not publish startup-readiness.jsonl; launch with --require harness/windows-readiness.cjs');
  }
  assert.equal(readiness.status, 'ready', 'Extension-host readiness gate');
  assert.equal(readiness.pluginActive, true, 'Flintmark must be active before cases');
  assert.equal(readiness.associationVerified, true, 'Markdown association must be verified before cases');
  fs.writeFileSync(path.join(out, 'startup.json'), JSON.stringify(startup, null, 2) + '\n');

  // The readiness anchor is only a gate fixture. It is closed through the UI
  // and removed before any of the 14 observed cases are opened.
  const anchorCleanup = await closeAllEditors();
  if (!anchorCleanup.confirmed) throw new Error('Could not close the readiness anchor tab');
  untitledTabsClosed += anchorCleanup.untitledClosed;
  fs.unlinkSync(readinessAnchor);
  createdFiles.delete(readinessAnchor);

  for (const meta of selected) {
    const result = await runCase(meta);
    results.push(result);
    console.log(JSON.stringify({file:meta.name,passed:result.passed,tabsClosed:result.tabsClosed,checks:result.records.length,durationMs:result.durationMs}));
    fs.writeFileSync(path.join(out,'corpus-progress.json'),JSON.stringify(results,null,2));
    if (!result.tabsClosed) {
      cleanupConfirmed = false;
      break;
    }
  }
} catch (error) {
  cleanupConfirmed = false;
  launchError = String(error?.stack || error);
  process.exitCode = 1;
  console.error(error);
  if (win) await win.screenshot({path: path.join(out, 'session-failure.png')}).catch(() => {});
} finally {
  if (cleanupConfirmed && results.every((result) => result.tabsClosed)) {
    for (const file of createdFiles) {
      try {
        fs.unlinkSync(file);
      } catch {
        retainedFiles.push(file);
      }
    }
  } else {
    retainedFiles = [...createdFiles];
  }

  fs.writeFileSync(path.join(out, 'startup.json'), JSON.stringify(startup, null, 2) + '\n');
  if (app) {
    // The Playwright Electron object can be disposed by a crash before finally.
    // Keep the actual ChildProcess captured at launch so evidence still closes.
    const child=ownedAppProcess;
    if (!child) {
      appCloseState='owned-process-unavailable';
      finalizationErrors.push('Owned process was unavailable after launch');
      process.exitCode=1;
    } else if (child.exitCode!==null || child.signalCode!==null) {
      appCloseState='exited-before-cleanup';
      process.exitCode=1;
    } else {
      appCloseState=await Promise.race([Promise.resolve().then(()=>app.close()).then(()=> 'closed',e=>'error:'+String(e)),sleep(15000).then(()=> 'timeout')]);
    }
    if(appCloseState==='closed'){
      const end=performance.now()+5000;while(child?.exitCode===null&&child?.signalCode===null&&performance.now()<end)await sleep(100);
      if(child?.exitCode===null&&child?.signalCode===null)appCloseState='close-returned-with-live-process';
    }
    if(appCloseState!=='closed'){
      if(process.platform==='win32'&&child?.pid)require('child_process').spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',timeout:10000});
      else child?.kill('SIGKILL');
      const end=performance.now()+5000;while(child?.exitCode===null&&child?.signalCode===null&&performance.now()<end)await sleep(100);
      process.exitCode=1;
    }
    ownedProcessTerminated=!!child&&(child.exitCode!==null||child.signalCode!==null);
  }
  try{if(fs.existsSync(path.join(profile,'logs')))archiveLogs(path.join(profile,'logs'),path.join(out,'host-logs'));}catch(error){finalizationErrors.push('HOST_LOG_COPY: '+String(error));process.exitCode=1;}

  const summary = {
    mode: 'single-session-lifecycle',
    lifecycle: true,
    platform: process.platform,
    arch: process.arch,
    executable,
    profile,
    workspace: work,
    startedAt: runStartedAt,
    durationMs: performance.now() - runStarted,
    selected: selected.map((meta) => meta.name),
    startup,
    cases: results,
    results,
    cleanup: {
      confirmed: !launchError && cleanupConfirmed && results.length===selected.length && results.every((result) => result.tabsClosed) && retainedFiles.length===0 && appCloseState==='closed' && ownedProcessTerminated,
      appCloseState,ownedProcessTerminated,
      untitledTabsClosed,
      retainedCreatedFiles: retainedFiles,
    },
    runtimeErrors,
    finalizationErrors,
    peakWorkingSetBytes,
    launchError,
    coldStartClaim: false,
    note: 'Single readiness-gated lifecycle/stress run. Retains the original per-case cold-start scripts/results; this run does not claim cold-start behavior is fixed.',
    passed: !launchError && finalizationErrors.length===0 && retainedFiles.length===0 && appCloseState==='closed' && ownedProcessTerminated &&
      results.length === selected.length &&
      results.every((result) => result.passed) &&
      cleanupConfirmed &&
      results.every((result) => result.tabsClosed) &&
      runtimeErrors.length === 0,
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  if (!summary.passed) process.exitCode = 1;
}

process.exit(process.exitCode || 0);

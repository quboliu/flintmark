import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const work = mkdtempSync(join(tmpdir(), 'flintmark-native-anchor-'));
const output = resolve(process.env.FLINTMARK_ANCHOR_RESULTS || 'out/metrics/native-scroll-anchor');
mkdirSync(output, { recursive: true });
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./fixtures/native-scroll-anchor.mjs', import.meta.url))],
  bundle: true, format: 'iife', platform: 'browser', write: false,
});
const script = bundle.outputFiles[0].contents;
const server = createServer((req, res) => {
  if (req.url === '/scene.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(script);
  } else if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta charset="utf-8"><title>Native scroll anchor regressions</title><script defer src="/scene.js"></script>');
  } else { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const results = [], pageErrors = [];
let app;
try {
  mkdirSync(join(work, 'user', 'User'), { recursive: true });
  writeFileSync(join(work, 'user', 'User', 'settings.json'), JSON.stringify({
    'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none',
  }));
  app = await electron.launch({
    executablePath: process.env.VSCODE_BIN || '/usr/share/codium/codium',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--user-data-dir', join(work, 'user'),
      '--extensions-dir', join(work, 'extensions'), '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
    timeout: 120000,
  });
  await app.firstWindow();
  await app.evaluate(async ({ BrowserWindow }, url) => {
    const window = new BrowserWindow({ width: 1000, height: 700, show: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true } });
    await window.loadURL(url);
  }, url);
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    page = app.windows().find(candidate => candidate.url() === url);
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, 'Regression window opened');
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.waitForFunction(() => !!window.anchorRegression);
  for (const scale of [1, 0.8, 1.25]) {
    for (const kind of ['shrink-before-measure', 'fractional-changes', 'round-trips',
      'set-state-immediate-edit', 'edit-before-anchor', 'snapshot-restore', 'explicit-navigation',
      'top', 'bottom', 'outer', 'window', 'outer-scaled-parent', 'unattainable-target',
      'motion-read-down', 'motion-read-up', 'motion-write-down', 'motion-write-up',
      'motion-read-unchanged-down', 'motion-write-unchanged-down',
      'motion-outer-read-down', 'motion-outer-write-up',
      'motion-window-read-down', 'motion-window-write-up',
      'motion-bottom-read-up', 'motion-bottom-write-up',
      'motion-late-down', 'motion-late-up',
      'motion-outer-late-down', 'motion-outer-late-up',
      'motion-window-late-down', 'motion-window-late-up']) {
      let result;
      try { result = await page.evaluate(({ kind, scale }) => window.anchorRegression.run(kind, scale), { kind, scale }); }
      catch (error) { result = { kind, scale, pass: false, error: String(error) }; }
      results.push(result);
      writeFileSync(join(output, 'results.json'), JSON.stringify({ results, pageErrors }, null, 2));
      console.log(`${result.pass ? 'PASS' : 'FAIL'} ${kind} scale=${scale}`);
      if (!result.pass) await page.screenshot({ path: join(output, `${kind}-${scale}.png`) });
    }
  }
  assert.equal(results.length, 93);
  assert.deepEqual(pageErrors, [], 'No uncaught browser errors');
  assert.equal(results.filter(result => !result.pass).length, 0, 'All native scroll anchor regressions pass');
} finally {
  await app?.close();
  await new Promise(resolve => server.close(resolve));
}

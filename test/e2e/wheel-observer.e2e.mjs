import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { positiveWheel } from './wheelCompletion.mjs';

// Exercise the observer against real native scrolling, including deliberately
// broken input. These are measurement controls, not changes to Flintmark.
const work = mkdtempSync(join(tmpdir(), 'flintmark-wheel-observer-'));
const output = resolve(process.env.FLINTMARK_OBSERVER_RESULTS || 'out/metrics/wheel-observer');
mkdirSync(output, { recursive: true });
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Wheel observer controls</title>');
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
  assert.ok(page, 'Observer control window opened');
  page.on('pageerror', error => pageErrors.push(String(error)));
  for (const control of [
    { name: 'normal', mode: 'normal' },
    { name: 'late-observer', mode: 'normal', delay: 650 },
    { name: 'swallowed-input', mode: 'swallow', error: /no browser scroll progress/ },
    { name: 'slow-scroll', mode: 'slow', error: /no browser scroll progress|browser scroll progress exceeded/ },
    { name: 'late-observer-cannot-hide-slow-scroll', mode: 'slow', delay: 850, error: /browser scroll progress exceeded/ },
    { name: 'reversed-scroll', mode: 'reverse', error: /positive wheel reversed/ },
  ]) {
    await page.setContent('<main id="scroll" style="width:500px;height:400px;overflow:auto"><div style="height:20000px">Native scrolling control</div></main>');
    const scroller = page.locator('#scroll');
    await scroller.evaluate((element, mode) => {
      element.scrollTop = 1000;
      if (mode !== 'normal') element.addEventListener('wheel', event => {
        event.preventDefault();
        if (mode === 'slow') setTimeout(() => { element.scrollTop += event.deltaY; }, 650);
        if (mode === 'reverse') element.scrollTop -= event.deltaY;
      }, { passive: false });
    }, control.mode);
    await page.waitForTimeout(100);
    const box = await scroller.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const snapshot = () => scroller.evaluate(element => ({
      scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
    }));
    let sample, error = null;
    try {
      sample = await positiveWheel(page, scroller, snapshot, 200, null,
        { observerDelayMs: control.delay ?? 25 });
    } catch (caught) { error = String(caught); }
    if (control.error) assert.match(error || '', control.error, control.name);
    else {
      assert.equal(error, null, control.name);
      assert.equal(sample.after.scrollTop - sample.before.scrollTop, 200, control.name);
      if (control.delay) assert.ok(sample.observations[0].elapsedMs >= control.delay);
    }
    results.push({ name: control.name, pass: true, expectedFailure: !!control.error, sample, error });
    console.log('WHEEL_OBSERVER_CONTROL', JSON.stringify({ name: control.name, pass: true,
      expectedFailure: !!control.error, browserProgressMs: sample?.progressMs,
      driverObservedMs: sample?.observations.at(-1).elapsedMs }));
    await page.waitForTimeout(750); // drain the deliberately delayed native scroll
  }
  assert.deepEqual(pageErrors, []);
} finally {
  writeFileSync(join(output, 'results.json'), JSON.stringify({ results, pageErrors }, null, 2));
  await app?.close();
  await new Promise(resolve => server.close(resolve));
}

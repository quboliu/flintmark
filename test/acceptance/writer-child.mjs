// Test-only writer child for the Windows native-source stress control.
// Runs the 25 ms create/delete loop outside the Playwright parent event loop.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const FIXTURE = process.env.FLINTMARK_NOISE_FIXTURE;
const PREFIX = process.env.FLINTMARK_NOISE_PREFIX;
const INTERVAL_MS = Number(process.env.FLINTMARK_NOISE_INTERVAL_MS || 25);
if (!FIXTURE || !PREFIX) {
  process.stderr.write('writer requires FLINTMARK_NOISE_FIXTURE and FLINTMARK_NOISE_PREFIX\n');
  process.exit(2);
}
if (!Number.isFinite(INTERVAL_MS) || INTERVAL_MS <= 0) {
  process.stderr.write('writer requires a positive FLINTMARK_NOISE_INTERVAL_MS\n');
  process.exit(2);
}

const startedAt = new Date().toISOString();
const startedMonotonic = performance.now();
let timer = null;
let stopping = false;
let attempts = 0;
let operations = 0;
let totalOpMs = 0;
let maxOpMs = 0;
const durationsMs = [];
const errors = [];
let durationsTruncated = false;

function report(type) {
  return {
    type,
    pid: process.pid,
    intervalMs: INTERVAL_MS,
    prefix: PREFIX,
    startedAt,
    stoppedAt: new Date().toISOString(),
    runMs: performance.now() - startedMonotonic,
    attempts,
    operations,
    totalOpMs,
    maxOpMs,
    durationsMs,
    durationsTruncated,
    errors: [...errors],
    stopAcknowledgement: type === 'stopped',
  };
}

function send(message, callback) {
  if (typeof process.send !== 'function' || !process.connected) {
    if (callback) callback(new Error('IPC is not connected'));
    return;
  }
  try {
    process.send(message, callback);
  } catch (error) {
    if (callback) callback(error);
  }
}

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function tick() {
  if (stopping) return;
  const started = performance.now();
  attempts++;
  const file = path.join(FIXTURE, `${PREFIX}${operations}.json`);
  try {
    fs.writeFileSync(file, '{}');
    fs.unlinkSync(file);
    operations++;
  } catch (error) {
    errors.push(String(error));
    stopTimer();
    send({ type: 'worker-error', ...report('worker-error') });
  } finally {
    const elapsed = performance.now() - started;
    totalOpMs += elapsed;
    maxOpMs = Math.max(maxOpMs, elapsed);
    if (durationsMs.length < 10000) durationsMs.push(elapsed);
    else durationsTruncated = true;
  }
}

process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'snapshot') {
    send(report('snapshot'));
    return;
  }
  if (message.type === 'stop' && !stopping) {
    stopping = true;
    stopTimer();
    const final = report('stopped');
    send(final, () => process.exit(errors.length === 0 ? 0 : 1));
    // Do not hang forever if the IPC callback is never delivered.
    const forceExit = setTimeout(() => process.exit(errors.length === 0 ? 0 : 1), 1000);
    forceExit.unref();
  }
});

process.on('SIGTERM', () => {
  stopTimer();
  process.exit(errors.length === 0 ? 0 : 1);
});
process.on('disconnect', () => {
  stopTimer();
  process.exit(errors.length === 0 ? 0 : 1);
});
process.on('uncaughtException', (error) => {
  errors.push(String(error));
  stopTimer();
  send({ type: 'worker-error', ...report('worker-error') });
});
process.on('unhandledRejection', (error) => {
  errors.push(String(error));
  stopTimer();
  send({ type: 'worker-error', ...report('worker-error') });
});

send({ type: 'ready', ...report('ready') }, (error) => {
  if (error) process.exit(2);
});
// Start only after the ready message is queued. The parent waits for ready
// before launching the GUI, so the writer is established first.
timer = setInterval(tick, INTERVAL_MS);

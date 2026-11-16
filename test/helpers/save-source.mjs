import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
let sequence = 0;

// Functional save completion, not a performance benchmark. One native save must
// persist the entire expected document within the existing 10-second budget.
export async function observeSavedSource(win, file, source, started, options = {}) {
  const expected = Buffer.from(source);
  const budgetMs = options.budgetMs ?? 10000;
  const checkpointMs = options.checkpointMs ?? 1200;
  const deadline = started + budgetMs;
  await win.waitForTimeout(Math.min(checkpointMs, Math.max(0, deadline - performance.now())));
  let bytes = readFileSync(file), readEnded = performance.now();
  const checkpoint = {elapsedMs:readEnded-started,exact:bytes.equals(expected)};
  const checkpointSource = bytes.toString('utf8');
  while (!bytes.equals(expected) && performance.now() < deadline) {
    await win.waitForTimeout(Math.min(100, Math.max(0, deadline - performance.now())));
    bytes = readFileSync(file);
    readEnded = performance.now();
  }
  const result = {checkpoint,completedMs:readEnded-started,budgetMs,exact:bytes.equals(expected),withinBudget:bytes.equals(expected)&&readEnded<=deadline};
  console.log('SINGLE_SAVE_COMPLETION',JSON.stringify(result));
  const out = process.env.FLINTMARK_TRIAGE_OUT || process.env.FLINTMARK_OUT;
  if (out && (!checkpoint.exact || !result.withinBudget)) {
    mkdirSync(out,{recursive:true});
    writeFileSync(join(out,`single-save-${++sequence}.json`),JSON.stringify({...result,expected:expected.toString('utf8'),checkpointSource,actual:bytes.toString('utf8')},null,2)+'\n');
  }
  assert.ok(result.withinBudget,`One save must persist the entire expected source: ${JSON.stringify(result)}`);
  return bytes.toString('utf8');
}

export async function saveExpectedSource(win, file, source, options) {
  const started = performance.now();
  await win.keyboard.press('Control+S');
  return observeSavedSource(win, file, source, started, options);
}

export async function savePreviewSource(win, frame, file, options) {
  const expected = await frame.evaluate(() => document.querySelector('.cm-content').cmTile.root.view.state.doc.toString());
  return saveExpectedSource(win,file,expected,options);
}

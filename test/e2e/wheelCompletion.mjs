import assert from "node:assert/strict";

// mouse.wheel only dispatches input; it does not await scrolling. Keep the
// original 25ms checkpoint, then observe this SAME input within a 500ms bound.
// Never send a second wheel to make a stalled first wheel appear successful.
export async function positiveWheel(page, snapshot, delta, complete = null) {
  const before = await snapshot();
  const started = performance.now();
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(25);
  const observations = [];
  let after;
  do {
    after = await snapshot();
    const elapsedMs = performance.now() - started;
    observations.push({ elapsedMs, scrollTop: after.scrollTop });
    assert.ok(after.scrollTop >= before.scrollTop - 1,
      `positive wheel reversed: ${JSON.stringify({ before, after, observations })}`);
    const atBottom = before.scrollTop >= before.scrollHeight - before.clientHeight - 5;
    const advanced = after.scrollTop > before.scrollTop + 1;
    if ((atBottom || advanced) && (!complete || complete(before, after))) {
      assert.ok(elapsedMs <= 500, `wheel completion exceeded 500ms: ${JSON.stringify(observations)}`);
      return { before, after, checkpoint: observations[0], observations };
    }
    if (elapsedMs >= 500) break;
    await page.waitForTimeout(Math.min(25, 500 - elapsedMs));
  } while (true);
  assert.fail(`one wheel must complete within 500ms without another input: ${JSON.stringify({ delta, before, after, observations })}`);
}

// Verify actual visible text/table displacement, independently of CM's height
// estimates. Unvisited virtualized gaps may legitimately shrink on measurement.
export async function verifyVisibleWheelDisplacement(page, scroller) {
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await page.waitForTimeout(500);
  const snapshot = () => scroller.evaluate((element) => {
    const view = document.querySelector(".cm-content").cmTile.root.view;
    const viewport = element.getBoundingClientRect();
    const nodes = [...document.querySelectorAll(".cm-line,.ofm-table-wrap")].flatMap((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) return [];
      const key = node.matches(".ofm-table-wrap")
        ? "table:" + node.getAttribute("data-ofm-table-from")
        : "line:" + view.posAtDOM(node, 0) + ":" + node.textContent;
      return [{ key, top: rect.top }];
    });
    return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight, nodes };
  });
  const compare = (before, after) => {
    const prior = new Map(before.nodes.map((node) => [node.key, node.top]));
    return after.nodes.filter((node) => prior.has(node.key)).map((node) => ({
      key: node.key, errorPx: prior.get(node.key) - node.top - 200,
    }));
  };
  const samples = [];
  for (let input = 0; input < 200; input++) {
    const sample = await positiveWheel(page, snapshot, 200, (before, after) =>
      compare(before, after).every((match) => Math.abs(match.errorPx) <= 1)
    );
    samples.push({ input, ...sample, matches: compare(sample.before, sample.after) });
  }
  assert.ok(samples.filter((sample) => sample.matches.length).length >= 180,
    "At least 180 gestures must retain common visible DOM anchors");
  const matches = samples.flatMap((sample) => sample.matches);
  const summary = { gestures: samples.length, matchedPositions: matches.length,
    maxErrorPx: Math.max(...matches.map((match) => Math.abs(match.errorPx))),
    delayedGestures: samples.filter((sample) => sample.observations.length > 1).length,
    maxCompletionMs: Math.max(...samples.map((sample) => sample.observations.at(-1).elapsedMs)) };
  console.log("VISIBLE_WHEEL_DISPLACEMENT", JSON.stringify(summary));
  return { summary, samples };
}

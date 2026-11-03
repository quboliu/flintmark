import assert from "node:assert/strict";

// Input latency is measured in the browser's clock. A slow Playwright reply
// must not turn an already completed scroll into a product timeout. Keep a
// separate bounded driver wait, and never send another wheel to hide a stall.
export async function positiveWheel(page, scroller, snapshot, delta, complete = null, options = {}) {
  const before = await snapshot();
  await scroller.evaluate((element) => {
    if (!element.__flintmarkWheelObserver) {
      const observer = { current: null };
      element.addEventListener("wheel", (event) => {
        if (observer.current) observer.current.wheels.push({
          at: performance.now(), eventTime: event.timeStamp, deltaY: event.deltaY,
        });
      }, { capture: true, passive: true });
      element.addEventListener("scroll", (event) => {
        if (event.target === element && observer.current) observer.current.scrolls.push({
          at: performance.now(), top: element.scrollTop,
        });
      }, { passive: true });
      element.__flintmarkWheelObserver = observer;
    }
    element.__flintmarkWheelObserver.current = { armedAt: performance.now(), wheels: [], scrolls: [] };
  });
  const started = performance.now();
  await page.mouse.wheel(0, delta);
  const dispatchReturnedMs = performance.now() - started;
  // The optional delay is used only by the observer's causal regression test.
  await page.waitForTimeout(options.observerDelayMs ?? 25);
  const observations = [];
  let after;
  do {
    const snapshotStartedMs = performance.now() - started;
    after = await snapshot();
    const snapshotReturnedMs = performance.now() - started;
    const browser = await scroller.evaluate((element) => ({
      ...element.__flintmarkWheelObserver.current, now: performance.now(),
    }));
    const wheel = browser.wheels[0];
    const atBottom = before.scrollTop >= before.scrollHeight - before.clientHeight - 5;
    const firstAdvance = wheel && browser.scrolls.find((sample) =>
      sample.at >= wheel.at && sample.top > before.scrollTop + 1
    );
    const progressMs = wheel && (firstAdvance || atBottom)
      ? (firstAdvance?.at ?? wheel.at) - wheel.eventTime : null;
    const elapsedMs = performance.now() - started;
    observations.push({ elapsedMs, snapshotStartedMs, snapshotReturnedMs,
      dispatchReturnedMs, scrollTop: after.scrollTop, browserProgressMs: progressMs });
    assert.ok(after.scrollTop >= before.scrollTop - 1,
      `positive wheel reversed: ${JSON.stringify({ before, after, observations })}`);
    if (wheel) {
      assert.equal(browser.wheels.length, 1, "one command must deliver exactly one wheel");
      assert.equal(wheel.deltaY, delta, "the observed wheel must match the commanded delta");
      assert.ok(wheel.eventTime >= browser.armedAt - 1 && wheel.eventTime <= wheel.at + 1,
        "wheel timestamps must use the browser's monotonic clock");
    }
    if (progressMs !== null) {
      assert.ok(progressMs <= 500,
        `browser scroll progress exceeded 500ms: ${JSON.stringify({ browser, progressMs, observations })}`);
      if (atBottom || after.scrollTop > before.scrollTop + 1) {
        assert.ok(!complete || complete(before, after),
          `visible content displacement did not match the completed input: ${JSON.stringify({ before, after, browser, observations })}`);
        assert.ok(elapsedMs <= 5000, "driver observation exceeded its separate 5000ms bound");
        return { before, after, checkpoint: observations[0], observations, browser, progressMs };
      }
    } else if (wheel && browser.now - wheel.eventTime > 500) {
      assert.fail(`no browser scroll progress within 500ms: ${JSON.stringify({ before, after, browser, observations })}`);
    }
    if (elapsedMs >= 5000) break;
    await page.waitForTimeout(25);
  } while (true);
  assert.fail(`driver could not observe this wheel within 5000ms: ${JSON.stringify({ delta, before, after, observations })}`);
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
    const sample = await positiveWheel(page, scroller, snapshot, 200, (before, after) =>
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
    maxBrowserProgressMs: Math.max(...samples.map((sample) => sample.progressMs)),
    maxDriverObservationMs: Math.max(...samples.map((sample) => sample.observations.at(-1).elapsedMs)) };
  console.log("VISIBLE_WHEEL_DISPLACEMENT", JSON.stringify(summary));
  return { summary, samples };
}

import assert from "node:assert";
import { EditorState } from "@codemirror/state";
import {
  mediaMeasurementsField,
  predictedImageHeight,
  predictedSvgBlockHeight,
  reconcileMediaProbeSources,
  destroyMediaProbes,
  setMediaMeasurements,
  stableMediaIdentity,
  svgIntrinsicSize,
  svgMediaIdentity,
} from "../../src/webview/view/mediaMeasurements";

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log("  ✓ " + name);
  } catch (error) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (error as Error).message);
  }
}

function mediaState(
  dimensions: readonly { identity: string; width: number; height: number }[] = []
): EditorState {
  let state = EditorState.create({ extensions: [mediaMeasurementsField] });
  state = state.update({
    effects: setMediaMeasurements.of({
      dimensions,
      contentWidth: 300,
      fontSizePx: 16,
    }),
  }).state;
  return state;
}

test("stable identities discard only Flintmark's cache-buster", () => {
  assert.equal(
    stableMediaIdentity("https://example.com/a.png?ofmIndex=9#fragment"),
    "https://example.com/a.png#fragment"
  );
  assert.equal(stableMediaIdentity("images/a.png?rev=2"), "images/a.png?rev=2");
  assert.equal(
    stableMediaIdentity("images/a.png?rev=2&ofmIndex=9&variant=wide#preview"),
    "images/a.png?rev=2&variant=wide#preview"
  );
});

test("same-path URLs with different queries retain independent aspect ratios", () => {
  const wide = "https://example.com/render.png?id=wide";
  const tall = "https://example.com/render.png?id=tall";
  const state = mediaState([
    { identity: stableMediaIdentity(wide), width: 400, height: 100 },
    { identity: stableMediaIdentity(tall), width: 100, height: 400 },
  ]);

  assert.notEqual(stableMediaIdentity(wide), stableMediaIdentity(tall));
  assert.equal(predictedImageHeight(state, wide)?.height, 75);
  assert.equal(predictedImageHeight(state, tall)?.height, 400);
});

test("explicit WxH can render before intrinsic media arrives", () => {
  const state = EditorState.create();
  assert.deepEqual(predictedImageHeight(state, "", 80, 40), {
    height: 40,
    layoutVersion: 0,
  });
});

test("width-only image waits for ratio, then uses it", () => {
  const src = "vscode-webview://asset/image.png?ofmIndex=7";
  assert.equal(predictedImageHeight(mediaState(), src, 80), undefined);
  const state = mediaState([
    { identity: stableMediaIdentity(src), width: 200, height: 100 },
  ]);
  assert.equal(predictedImageHeight(state, src, 80)?.height, 40);
});

test("unsized image is capped to the measured content width", () => {
  const src = "https://example.com/wide.png";
  const state = mediaState([
    { identity: stableMediaIdentity(src), width: 1200, height: 600 },
  ]);
  assert.equal(predictedImageHeight(state, src)?.height, 150);
});

test("SVG width/height and viewBox provide a synchronous aspect ratio", () => {
  assert.deepEqual(svgIntrinsicSize('<svg width="20" height="10"></svg>'), {
    width: 20,
    height: 10,
  });
  assert.deepEqual(svgIntrinsicSize('<svg width="40" viewBox="0 0 20 10"></svg>'), {
    width: 40,
    height: 20,
  });
  const source = '<svg viewBox="0 0 20 10"></svg>';
  assert.equal(predictedSvgBlockHeight(mediaState(), source)?.height, 166);
});

test("decoded SVG probe overrides source dimensions", () => {
  const source = '<svg width="20" height="10"></svg>';
  const state = mediaState([
    { identity: svgMediaIdentity(source), width: 100, height: 100 },
  ]);
  assert.equal(predictedSvgBlockHeight(state, source)?.height, 116);
});

test("513 current media probes reconcile without rolling re-probes", () => {
  const sources = Array.from({ length: 513 }, (_, index) => `https://example.com/${index}.png`);
  const probes = new Map(sources.map((source) => [source, { source }]));
  const cancelled: string[] = [];

  assert.deepEqual(
    reconcileMediaProbeSources(probes, sources, (probe) => cancelled.push(probe.source)),
    []
  );
  assert.equal(probes.size, 513, "all current-document probes remain tracked");

  const replacement = "https://example.com/replacement.png";
  const missing = reconcileMediaProbeSources(
    probes,
    [...sources.slice(1), replacement],
    (probe) => cancelled.push(probe.source)
  );
  assert.deepEqual(cancelled, [sources[0]], "an evicted probe is invalidated");
  assert.deepEqual(missing, [replacement], "only the newly introduced source is probed");
});

test("513 current media identities all retain their measured ratio", () => {
  const sources = Array.from({ length: 513 }, (_, index) => `https://example.com/${index}.png`);
  const state = mediaState(
    sources.map((source, index) => ({
      identity: stableMediaIdentity(source),
      width: 100 + index,
      height: 50,
    }))
  );

  assert.notEqual(predictedImageHeight(state, sources[0]), undefined);
  assert.notEqual(predictedImageHeight(state, sources[512]), undefined);
});

test("destroy invalidates every in-flight media probe", () => {
  const probes = new Map([
    ["slow-a", { source: "slow-a" }],
    ["slow-b", { source: "slow-b" }],
  ]);
  const cancelled: string[] = [];

  destroyMediaProbes(probes, (probe) => cancelled.push(probe.source));

  assert.deepEqual(cancelled, ["slow-a", "slow-b"]);
  assert.equal(probes.size, 0);
});

test("identity reconciliation wins over a stale dimension in the same effect", () => {
  const stale = "https://example.com/stale.png";
  let state = mediaState();
  state = state.update({
    effects: setMediaMeasurements.of({
      dimensions: [{ identity: stableMediaIdentity(stale), width: 200, height: 100 }],
      retainIdentities: [stableMediaIdentity("https://example.com/current.png")],
    }),
  }).state;

  assert.equal(predictedImageHeight(state, stale), undefined);
});

if (failed > 0) {
  console.error(`\n${failed} media measurement test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll media measurement tests passed");

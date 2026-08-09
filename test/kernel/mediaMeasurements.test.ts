import assert from "node:assert";
import { EditorState } from "@codemirror/state";
import {
  mediaMeasurementsField,
  predictedImageHeight,
  predictedSvgBlockHeight,
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

test("stable identities discard cache-busting query and fragment", () => {
  assert.equal(
    stableMediaIdentity("https://example.com/a.png?ofmIndex=9#fragment"),
    "https://example.com/a.png"
  );
  assert.equal(stableMediaIdentity("images/a.png?rev=2"), "images/a.png");
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

if (failed > 0) {
  console.error(`\n${failed} media measurement test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll media measurement tests passed");

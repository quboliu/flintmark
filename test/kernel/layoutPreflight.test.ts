import assert from "node:assert";
import type { EditorView } from "@codemirror/view";
import {
  FULL_DOCUMENT_LIVE_PREVIEW_CHAR_LIMIT,
  installHeightOracleRefreshGuard,
  requestHeightOracleRefresh,
  shouldGuardHeightOracleRefresh,
} from "../../src/webview/view/layoutPreflight";

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

function guardedOracle(docLength = 52_000): {
  oracle: { lineWrapping: boolean; lineHeight: number; refresh: (...args: unknown[]) => boolean };
  originalRefresh: (...args: unknown[]) => boolean;
  dispose: () => void;
} {
  const originalRefresh = function (this: {
    lineWrapping: boolean;
    lineHeight: number;
  }, whiteSpace: unknown, lineHeight: unknown): boolean {
    this.lineWrapping = whiteSpace === "pre-wrap";
    if (typeof lineHeight === "number") this.lineHeight = lineHeight;
    return true;
  };
  const oracle = { lineWrapping: false, lineHeight: 14, refresh: originalRefresh };
  const view = {
    state: { doc: { length: docLength } },
    viewState: { heightOracle: oracle },
  } as unknown as EditorView;
  return { oracle, originalRefresh, dispose: installHeightOracleRefreshGuard(view) };
}

test("the oracle guard is limited to full-document Live Preview", () => {
  assert.equal(shouldGuardHeightOracleRefresh(0), false);
  assert.equal(shouldGuardHeightOracleRefresh(1), true);
  assert.equal(shouldGuardHeightOracleRefresh(FULL_DOCUMENT_LIVE_PREVIEW_CHAR_LIMIT), true);
  assert.equal(shouldGuardHeightOracleRefresh(FULL_DOCUMENT_LIVE_PREVIEW_CHAR_LIMIT + 1), false);
  assert.equal(shouldGuardHeightOracleRefresh(Number.NaN), false);
  assert.equal(shouldGuardHeightOracleRefresh(1.5), false);
});

test("the oracle guard learns metrics but suppresses metric-only rebuilds", () => {
  const { oracle, originalRefresh, dispose } = guardedOracle();
  assert.equal(oracle.refresh("pre", 24), false, "line-height drift must not rebuild the map");
  assert.equal(oracle.lineHeight, 24, "the oracle must still learn the new metric");
  assert.equal(oracle.refresh("pre-wrap", 24), true, "wrapping changes still require a rebuild");
  dispose();
  assert.equal(oracle.refresh, originalRefresh, "destroy must restore CM6's method");
});

test("source-fallback documents retain CM6's native refresh decision", () => {
  const { oracle, dispose } = guardedOracle(FULL_DOCUMENT_LIVE_PREVIEW_CHAR_LIMIT + 1);
  assert.equal(oracle.refresh("pre", 24), true);
  dispose();
});

test("the guard degrades safely when CM6 internals are unavailable", () => {
  const view = { state: { doc: { length: 52_000 } } } as unknown as EditorView;
  assert.doesNotThrow(() => installHeightOracleRefreshGuard(view)());
});

test("an explicit metric refresh permits the next height-map rebuild exactly once", () => {
  let refreshResult: boolean | undefined;
  const oracle = {
    lineWrapping: false,
    lineHeight: 14,
    refresh(whiteSpace: unknown, lineHeight: unknown): boolean {
      this.lineWrapping = whiteSpace === "pre-wrap";
      if (typeof lineHeight === "number") this.lineHeight = lineHeight;
      return true;
    },
  };
  const view = {
    state: { doc: { length: 52_000 } },
    viewState: { heightOracle: oracle },
    requestMeasure: () => {
      refreshResult = oracle.refresh("pre", 24);
    },
  } as unknown as EditorView;
  const dispose = installHeightOracleRefreshGuard(view);

  requestHeightOracleRefresh(view);
  assert.equal(refreshResult, true, "the requested metric change must rebuild the height map");
  assert.equal(oracle.refresh("pre", 25), false, "ordinary metric sampling remains guarded");
  dispose();
});

test("an unchanged sampling refresh cannot consume an explicit layout refresh", () => {
  let requestedMeasures = 0;
  const oracle = {
    lineWrapping: false,
    lineHeight: 14,
    refresh(whiteSpace: unknown, lineHeight: unknown): boolean {
      const nextWrapping = whiteSpace === "pre-wrap";
      const nextLineHeight = typeof lineHeight === "number" ? lineHeight : this.lineHeight;
      const changed =
        nextWrapping !== this.lineWrapping || Math.abs(nextLineHeight - this.lineHeight) > 0.3;
      this.lineWrapping = nextWrapping;
      this.lineHeight = nextLineHeight;
      return changed;
    },
  };
  const view = {
    state: { doc: { length: 52_000 } },
    viewState: { heightOracle: oracle },
    requestMeasure: () => {
      requestedMeasures++;
    },
  } as unknown as EditorView;
  const dispose = installHeightOracleRefreshGuard(view);

  requestHeightOracleRefresh(view);
  assert.equal(requestedMeasures, 1);
  assert.equal(oracle.refresh("pre", 14), false, "an unchanged sample is not the requested rebuild");
  assert.equal(oracle.refresh("pre", 24), true, "the first changed sample must consume the permit");
  assert.equal(oracle.refresh("pre", 25), false, "the permit is single-use");
  dispose();
});

test("a document layout refresh keeps viewport limiting off through calibration", () => {
  type ScheduledMeasure = {
    read: (view: EditorView) => unknown;
    write?: (value: unknown, view: EditorView) => void;
  };
  let scheduledMeasure: ScheduledMeasure | undefined;
  const viewState = {
    heightOracle: {
      lineWrapping: false,
      refresh: () => true,
    },
    printing: false,
    mustMeasureContent: false as boolean | "refresh",
  };
  const view = {
    state: { doc: { length: 52_000 } },
    viewState,
    requestMeasure: (request?: unknown) => {
      scheduledMeasure = request as ScheduledMeasure | undefined;
    },
  } as unknown as EditorView;
  requestHeightOracleRefresh(view, "document");
  assert.equal(viewState.printing, true, "CM6 must materialize the full document viewport");
  assert.equal(viewState.mustMeasureContent, "refresh", "the height map must be rebuilt first");
  assert.ok(scheduledMeasure, "calibration completion must be tied to a measure request");
  const value = scheduledMeasure.read(view);
  assert.equal(viewState.printing, true, "the read phase still needs every decorated line mounted");
  scheduledMeasure.write?.(value, view);
  assert.equal(viewState.printing, false, "viewport limiting resumes only after the full read");
});

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll height-oracle refresh guard tests passed");

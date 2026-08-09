import assert from "node:assert";
import type { EditorView } from "@codemirror/view";
import {
  FULL_DOCUMENT_LIVE_PREVIEW_CHAR_LIMIT,
  installHeightOracleRefreshGuard,
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

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll height-oracle refresh guard tests passed");

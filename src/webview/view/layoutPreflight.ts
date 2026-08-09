import type { EditorView } from "@codemirror/view";

/** Above this size Live Preview deliberately falls back to stable source text. */
export const FULL_DOCUMENT_LIVE_PREVIEW_CHAR_LIMIT = 300_000;

export function shouldGuardHeightOracleRefresh(docLength: number): boolean {
  return (
    Number.isSafeInteger(docLength) &&
    docLength > 0 &&
    docLength <= FULL_DOCUMENT_LIVE_PREVIEW_CHAR_LIMIT
  );
}

interface HeightOracleEditorInternals {
  state: { doc: { length: number } };
  viewState?: {
    heightOracle?: {
      lineWrapping: boolean;
      refresh: (...args: unknown[]) => boolean;
    };
  };
}

/** CM6 may sample a heading or code line and infer a different baseline line
 * height. Keep those learned metrics, but suppress the destructive full-map
 * rebuild unless wrapping mode actually changed. */
export function installHeightOracleRefreshGuard(view: EditorView): () => void {
  const internal = view as unknown as HeightOracleEditorInternals;
  const oracle = internal.viewState?.heightOracle;
  if (!oracle) return () => undefined;
  const originalRefresh = oracle.refresh;
  if (typeof originalRefresh !== "function") return () => undefined;

  const guardedRefresh = (...args: unknown[]): boolean => {
    const wrappingBefore = oracle.lineWrapping;
    const refreshRequested = originalRefresh.apply(oracle, args);
    return shouldGuardHeightOracleRefresh(internal.state.doc.length)
      ? oracle.lineWrapping !== wrappingBefore
      : refreshRequested;
  };
  oracle.refresh = guardedRefresh;
  return () => {
    if (oracle.refresh === guardedRefresh) oracle.refresh = originalRefresh;
  };
}

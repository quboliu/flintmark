import type { EditorView } from "@codemirror/view";

const forcedRefreshViews = new WeakSet<EditorView>();
const documentRefreshMeasureKey = {};
const pendingDocumentRefreshes = new WeakMap<EditorView, { printingBefore: boolean }>();

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
    printing?: boolean;
    mustMeasureContent?: boolean | "refresh";
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
    if (refreshRequested && forcedRefreshViews.delete(view)) return true;
    return shouldGuardHeightOracleRefresh(internal.state.doc.length)
      ? oracle.lineWrapping !== wrappingBefore
      : refreshRequested;
  };
  oracle.refresh = guardedRefresh;
  return () => {
    forcedRefreshViews.delete(view);
    const pending = pendingDocumentRefreshes.get(view);
    if (pending && internal.viewState) internal.viewState.printing = pending.printingBefore;
    pendingDocumentRefreshes.delete(view);
    if (oracle.refresh === guardedRefresh) oracle.refresh = originalRefresh;
  };
}

/** Allow one native HeightOracle refresh for a known whole-layout change such
 * as live font settings or theme CSS, then restore the sampling-noise guard. */
export function requestHeightOracleRefresh(
  view: EditorView,
  scope: "viewport" | "document" = "viewport"
): void {
  forcedRefreshViews.add(view);
  const internal = view as unknown as HeightOracleEditorInternals;
  const viewState = internal.viewState;
  if (
    scope === "document" &&
    viewState &&
    shouldGuardHeightOracleRefresh(internal.state.doc.length)
  ) {
    if (!pendingDocumentRefreshes.has(view)) {
      pendingDocumentRefreshes.set(view, { printingBefore: viewState.printing === true });
    }
    viewState.printing = true;
    viewState.mustMeasureContent = "refresh";
    view.requestMeasure({
      key: documentRefreshMeasureKey,
      read: () => undefined,
      write: () => {
        const pending = pendingDocumentRefreshes.get(view);
        if (!pending) return;
        pendingDocumentRefreshes.delete(view);
        viewState.printing = pending.printingBefore;
        forcedRefreshViews.delete(view);
        // requestMeasure calls made in a measure write phase do not schedule a
        // RAF. Defer this one so CM6 shrinks the temporary full viewport again.
        queueMicrotask(() => view.requestMeasure());
      },
    });
    return;
  }
  view.requestMeasure();
}

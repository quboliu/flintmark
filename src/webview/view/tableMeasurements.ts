import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { findTableBlocks } from "./tableBlocks";
import { installHeightOracleRefreshGuard } from "./layoutPreflight";
import { buildTableWidgetDOM } from "./widgets/tableWidget";

export const TABLE_LAYOUT_CSS_REVISION = 1;
const MAX_CACHE_ENTRIES = 2_048;
const TABLES_PER_FRAME = 12;

export interface TableMeasurementEffect {
  signature: string;
  measurements: readonly { source: string; height: number }[];
  replace: boolean;
}

interface TableMeasurementState {
  signature: string;
  layoutVersion: number;
  heights: Map<string, number>;
}

export type TableMeasurementPublicationPlan =
  | { kind: "wait" | "none"; measurements: readonly [] }
  | {
      kind: "replace" | "incremental";
      measurements: readonly { source: string; height: number }[];
    };

/** Pure publication policy, separated from DOM measurement so signature
 * transitions can be regression-tested without Electron. */
export function planTableMeasurementPublication(
  activeSignature: string,
  activeHeights: ReadonlyMap<string, number>,
  targetSignature: string,
  sources: readonly string[],
  targetHeights: ReadonlyMap<string, number>
): TableMeasurementPublicationPlan {
  const available = sources.flatMap((source) => {
    const height = targetHeights.get(source);
    return height === undefined ? [] : [{ source, height }];
  });
  if (targetSignature !== activeSignature) {
    if (available.length !== sources.length) return { kind: "wait", measurements: [] };
    return { kind: "replace", measurements: available };
  }
  const changed = available.filter(
    ({ source, height }) => activeHeights.get(source) !== Math.ceil(height)
  );
  return changed.length > 0
    ? { kind: "incremental", measurements: changed }
    : { kind: "none", measurements: [] };
}

export const setTableMeasurements = StateEffect.define<TableMeasurementEffect>();

export const tableMeasurementsField = StateField.define<TableMeasurementState>({
  create: () => ({ signature: "", layoutVersion: 0, heights: new Map() }),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (!effect.is(setTableMeasurements)) continue;
      const signatureChanged = effect.value.signature !== next.signature;
      // A new layout signature is only legal as one explicit full replacement.
      // Ignore stale/partial batches instead of implicitly clearing live heights.
      if (signatureChanged && !effect.value.replace) continue;
      const replace = effect.value.replace;
      const heights = replace ? new Map<string, number>() : new Map(next.heights);
      for (const measurement of effect.value.measurements) {
        if (!Number.isFinite(measurement.height) || measurement.height <= 0) continue;
        heights.delete(measurement.source);
        heights.set(measurement.source, Math.ceil(measurement.height));
        while (heights.size > MAX_CACHE_ENTRIES) heights.delete(heights.keys().next().value!);
      }
      next = {
        signature: effect.value.signature,
        layoutVersion: next.layoutVersion + 1,
        heights,
      };
    }
    return next;
  },
});

export function reliableTableHeight(
  state: EditorState,
  source: string
): { height: number; layoutVersion: number } | undefined {
  const measurements = state.field(tableMeasurementsField, false);
  const height = measurements?.heights.get(source);
  return height === undefined
    ? undefined
    : { height, layoutVersion: measurements!.layoutVersion };
}

interface LayoutSnapshot {
  signature: string;
  borderBoxWidth: number;
  paddingLeft: string;
  paddingRight: string;
  borderLeft: string;
  borderRight: string;
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  letterSpacing: string;
  wordSpacing: string;
  whiteSpace: string;
  wordBreak: string;
  overflowWrap: string;
}

interface PendingTable {
  source: string;
  cacheKey: string;
  element: HTMLElement;
}

class TableMeasurementController {
  private readonly rack: HTMLElement;
  private readonly cache = new Map<string, number>();
  private readonly resizeObserver: ResizeObserver;
  private scheduled = false;
  private batchInFlight = false;
  private rescheduleAfterBatch = false;
  private destroyed = false;
  private activeSignature = "";
  private measuringSignature = "";
  private readonly publishedHeights = new Map<string, number>();
  private frameId: number | undefined;
  private tableMeasurementsPending = 0;
  private layoutRevision = 0;
  private readonly disposeHeightOracleRefreshGuard: () => void;
  private readonly fontDone = (): void => this.remeasure("font-loadingdone", true);

  constructor(private readonly view: EditorView) {
    this.disposeHeightOracleRefreshGuard = installHeightOracleRefreshGuard(this.view);
    this.rack = document.createElement("div");
    // Match selectors that apply specifically to direct children of
    // `.cm-content`, while keeping the rack outside CM6's managed DOM.
    this.rack.className = this.view.contentDOM.className;
    this.rack.classList.add("ofm-table-measure-rack");
    this.rack.setAttribute("aria-hidden", "true");
    Object.assign(this.rack.style, {
      position: "absolute",
      visibility: "hidden",
      pointerEvents: "none",
      overflow: "visible",
      height: "auto",
      minHeight: "0",
      top: "0",
      left: "0",
      zIndex: "-1",
    });
    this.view.scrollDOM.appendChild(this.rack);
    this.resizeObserver = new ResizeObserver(() => this.remeasure("content-resize", false));
    this.resizeObserver.observe(this.view.contentDOM, { box: "content-box" });
    const fonts = document.fonts;
    void fonts?.ready.then(() => this.remeasure("fonts-ready", true));
    fonts?.addEventListener?.("loadingdone", this.fontDone);
    this.schedule();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.geometryChanged) this.schedule();
  }

  remeasure(_reason: string, clear: boolean): void {
    if (clear) this.cache.clear();
    this.schedule();
  }

  private schedule(): void {
    if (this.destroyed) return;
    if (this.batchInFlight) {
      this.rescheduleAfterBatch = true;
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    this.view.requestMeasure({
      read: () => this.readLayout(),
      write: (layout) => {
        this.scheduled = false;
        this.prepareBatch(layout);
      },
    });
  }

  private readLayout(): LayoutSnapshot {
    const rect = this.view.contentDOM.getBoundingClientRect();
    const style = getComputedStyle(this.view.contentDOM);
    const themeLink = document.getElementById("ofm-theme") as HTMLLinkElement | null;
    const signatureParts = [
      rect.width.toFixed(3),
      style.paddingLeft,
      style.paddingRight,
      style.borderLeftWidth,
      style.borderRightWidth,
      style.fontFamily,
      style.fontSize,
      style.lineHeight,
      style.letterSpacing,
      style.wordSpacing,
      style.whiteSpace,
      style.wordBreak,
      style.overflowWrap,
      document.body.className,
      themeLink?.href ?? "",
      TABLE_LAYOUT_CSS_REVISION,
    ];
    return {
      signature: signatureParts.join("\u0000"),
      borderBoxWidth: rect.width,
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      borderLeft: style.borderLeftWidth,
      borderRight: style.borderRightWidth,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      wordSpacing: style.wordSpacing,
      whiteSpace: style.whiteSpace,
      wordBreak: style.wordBreak,
      overflowWrap: style.overflowWrap,
    };
  }

  private prepareBatch(layout: LayoutSnapshot): void {
    if (this.destroyed) return;
    if (layout.signature !== this.measuringSignature) {
      this.measuringSignature = layout.signature;
      this.rack.dataset.ofmTableLayoutVersion = String(++this.layoutRevision);
    }

    const unique = this.currentSources();
    const batch = unique
      .filter((source) => !this.cache.has(cacheKey(layout.signature, source)))
      .slice(0, TABLES_PER_FRAME);
    const remaining = unique.filter(
      (source) => !this.cache.has(cacheKey(layout.signature, source))
    ).length;
    this.setTableMeasurementsPending(remaining);
    if (batch.length === 0) {
      if (layout.signature === this.measuringSignature) {
        this.publishReady(layout.signature, this.currentSources());
      }
      this.finishBatch(false);
      return;
    }

    Object.assign(this.rack.style, {
      boxSizing: "border-box",
      width: `${layout.borderBoxWidth}px`,
      maxWidth: "none",
      paddingLeft: layout.paddingLeft,
      paddingRight: layout.paddingRight,
      paddingTop: "0",
      paddingBottom: "0",
      borderLeftWidth: layout.borderLeft,
      borderRightWidth: layout.borderRight,
      fontFamily: layout.fontFamily,
      fontSize: layout.fontSize,
      lineHeight: layout.lineHeight,
      letterSpacing: layout.letterSpacing,
      wordSpacing: layout.wordSpacing,
      whiteSpace: layout.whiteSpace,
      wordBreak: layout.wordBreak,
      overflowWrap: layout.overflowWrap,
    });
    const pending: PendingTable[] = batch.map((source) => {
      const element = buildTableWidgetDOM(source, 0, "measure-only");
      // `visibility:hidden` suppresses Chromium's horizontal scrollbar box.
      // Override it on the measured wrapper, then hide pixels with opacity so
      // overflow:auto contributes exactly the same height as the mounted DOM.
      element.style.visibility = "visible";
      element.style.opacity = "0";
      // WidgetTile applies this attribute to the mounted wrapper. Mirror it so
      // theme selectors and Chromium's editable layout rules are identical.
      element.contentEditable = "false";
      return {
        source,
        cacheKey: cacheKey(layout.signature, source),
        element,
      };
    });
    this.rack.replaceChildren(...pending.map((item) => item.element));
    this.batchInFlight = true;

    this.view.requestMeasure({
      read: () => ({
        signature: layout.signature,
        measurements: pending.map((item) => ({
          source: item.source,
          cacheKey: item.cacheKey,
          height: item.element.getBoundingClientRect().height,
        })),
      }),
      write: (result) => {
        this.batchInFlight = false;
        if (result.signature !== this.measuringSignature) {
          this.finishBatch(true);
          return;
        }
        this.rack.replaceChildren();
        for (const item of result.measurements) this.putCache(item.cacheKey, Math.ceil(item.height));
        const sources = this.currentSources();
        const remainingAfter = sources.filter(
          (source) => !this.cache.has(cacheKey(result.signature, source))
        ).length;
        this.setTableMeasurementsPending(remainingAfter);
        this.publishReady(result.signature, sources);
        this.finishBatch(remainingAfter > 0);
      },
    });
  }

  private currentSources(): string[] {
    const doc = this.view.state.doc.toString();
    return [
      ...new Set(findTableBlocks(doc).map((block) => doc.slice(block.from, block.to))),
    ];
  }

  private targetHeights(signature: string, sources: readonly string[]): Map<string, number> {
    const heights = new Map<string, number>();
    for (const source of sources) {
      const height = this.cache.get(cacheKey(signature, source));
      if (height !== undefined) heights.set(source, height);
    }
    return heights;
  }

  private publishReady(signature: string, sources: readonly string[]): void {
    const currentSources = new Set(sources);
    for (const source of this.publishedHeights.keys()) {
      if (!currentSources.has(source)) this.publishedHeights.delete(source);
    }
    const plan = planTableMeasurementPublication(
      this.activeSignature,
      this.publishedHeights,
      signature,
      sources,
      this.targetHeights(signature, sources)
    );
    if (plan.kind === "wait" || plan.kind === "none") return;
    queueMicrotask(() => {
      if (this.destroyed || signature !== this.measuringSignature) return;
      if (plan.kind === "replace") this.publishedHeights.clear();
      for (const measurement of plan.measurements) {
        this.publishedHeights.set(measurement.source, Math.ceil(measurement.height));
      }
      while (this.publishedHeights.size > MAX_CACHE_ENTRIES) {
        this.publishedHeights.delete(this.publishedHeights.keys().next().value!);
      }
      this.activeSignature = signature;
      this.view.dispatch({
        effects: setTableMeasurements.of({
          signature,
          measurements: plan.measurements,
          replace: plan.kind === "replace",
        }),
      });
    });
  }

  private setTableMeasurementsPending(count: number): void {
    this.tableMeasurementsPending = count;
    this.updatePendingStatus();
  }

  private updatePendingStatus(): void {
    this.rack.dataset.ofmTableMeasurementsPending = String(this.tableMeasurementsPending);
  }

  private finishBatch(needsAnotherBatch: boolean): void {
    const shouldSchedule = needsAnotherBatch || this.rescheduleAfterBatch;
    this.rescheduleAfterBatch = false;
    if (!shouldSchedule || this.destroyed) return;
    if (this.frameId !== undefined) cancelAnimationFrame(this.frameId);
    this.frameId = requestAnimationFrame(() => {
      this.frameId = undefined;
      this.schedule();
    });
  }

  private putCache(key: string, height: number): void {
    this.cache.delete(key);
    this.cache.set(key, height);
    while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
  }

  destroy(): void {
    this.destroyed = true;
    this.disposeHeightOracleRefreshGuard();
    this.resizeObserver.disconnect();
    document.fonts?.removeEventListener?.("loadingdone", this.fontDone);
    if (this.frameId !== undefined) cancelAnimationFrame(this.frameId);
    this.rack.remove();
  }
}

function cacheKey(signature: string, source: string): string {
  return `${signature}\u0000${source}`;
}

export const tableMeasurementsPlugin = ViewPlugin.fromClass(TableMeasurementController);

export function remeasureTables(view: EditorView, reason: string, clear = false): void {
  view.plugin(tableMeasurementsPlugin)?.remeasure(reason, clear);
}

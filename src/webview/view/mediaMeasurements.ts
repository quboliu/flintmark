import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { imageMapField, setImageMap } from "./widgets/imageWidget";
import { sanitizedSvgDataUri } from "./widgets/svgWidget";
import { documentMeasurementScan } from "./documentMeasurements";

export function reconcileMediaProbeSources<T>(
  probes: Map<string, T>,
  desiredSources: Iterable<string>,
  cancel: (probe: T) => void
): string[] {
  const desired = new Set(desiredSources);
  for (const [source, probe] of probes) {
    if (desired.has(source)) continue;
    probes.delete(source);
    cancel(probe);
  }
  return [...desired].filter((source) => !probes.has(source));
}

export function destroyMediaProbes<T>(
  probes: Map<string, T>,
  cancel: (probe: T) => void
): void {
  for (const probe of probes.values()) cancel(probe);
  probes.clear();
}

export interface IntrinsicSize {
  width: number;
  height: number;
}

interface MediaMeasurementEffect {
  dimensions?: readonly { identity: string; width: number; height: number }[];
  contentWidth?: number;
  fontSizePx?: number;
  retainIdentities?: readonly string[];
}

interface MediaMeasurementState {
  dimensions: Map<string, IntrinsicSize>;
  contentWidth: number;
  fontSizePx: number;
  layoutVersion: number;
}

export const setMediaMeasurements = StateEffect.define<MediaMeasurementEffect>();

export const mediaMeasurementsField = StateField.define<MediaMeasurementState>({
  create: () => ({ dimensions: new Map(), contentWidth: 0, fontSizePx: 0, layoutVersion: 0 }),
  update(value, transaction) {
    let next = value;
    for (const effect of transaction.effects) {
      if (!effect.is(setMediaMeasurements)) continue;
      const dimensions = new Map(next.dimensions);
      for (const item of effect.value.dimensions ?? []) {
        if (!isPositive(item.width) || !isPositive(item.height)) continue;
        dimensions.delete(item.identity);
        dimensions.set(item.identity, { width: item.width, height: item.height });
      }
      if (effect.value.retainIdentities) {
        const retained = new Set(effect.value.retainIdentities);
        for (const identity of dimensions.keys()) {
          if (!retained.has(identity)) dimensions.delete(identity);
        }
      }
      next = {
        dimensions,
        contentWidth: effect.value.contentWidth ?? next.contentWidth,
        fontSizePx: effect.value.fontSizePx ?? next.fontSizePx,
        layoutVersion: next.layoutVersion + 1,
      };
    }
    return next;
  },
});

export function stableMediaIdentity(src: string): string {
  if (/^data:/i.test(src)) return src;
  const hashAt = src.indexOf("#");
  const beforeHash = hashAt >= 0 ? src.slice(0, hashAt) : src;
  const hash = hashAt >= 0 ? src.slice(hashAt) : "";
  const queryAt = beforeHash.indexOf("?");
  if (queryAt < 0) return src;
  const path = beforeHash.slice(0, queryAt);
  const query = beforeHash.slice(queryAt + 1);
  const kept = query.split("&").filter((part) => queryParameterName(part) !== "ofmIndex");
  return `${path}${kept.length > 0 ? `?${kept.join("&")}` : ""}${hash}`;
}

function queryParameterName(part: string): string {
  const equalsAt = part.indexOf("=");
  const raw = equalsAt < 0 ? part : part.slice(0, equalsAt);
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

export function predictedImageHeight(
  state: EditorState,
  src: string,
  width?: number,
  height?: number
): { height: number; layoutVersion: number } | undefined {
  if (isPositive(width) && isPositive(height)) return { height: height!, layoutVersion: 0 };
  const media = state.field(mediaMeasurementsField, false);
  const intrinsic = media?.dimensions.get(stableMediaIdentity(src));
  if (!media || !intrinsic || !isPositive(media.contentWidth)) return undefined;
  const renderedWidth = Math.min(width ?? intrinsic.width, media.contentWidth);
  return {
    height: Math.ceil((renderedWidth * intrinsic.height) / intrinsic.width),
    layoutVersion: media.layoutVersion,
  };
}

export function predictedSvgBlockHeight(
  state: EditorState,
  source: string
): { height: number; layoutVersion: number } | undefined {
  const media = state.field(mediaMeasurementsField, false);
  const intrinsic = media?.dimensions.get(svgMediaIdentity(source)) ?? svgIntrinsicSize(source);
  if (!media || !intrinsic || !isPositive(media.contentWidth)) return undefined;
  const renderedWidth = Math.min(intrinsic.width, media.contentWidth);
  return {
    height: Math.ceil(
      (renderedWidth * intrinsic.height) / intrinsic.width + media.fontSizePx
    ),
    layoutVersion: media.layoutVersion,
  };
}

export function svgMediaIdentity(source: string): string {
  return `svg-source:${source}`;
}

/** Read a usable SVG aspect ratio without constructing DOM or waiting for an image load. */
export function svgIntrinsicSize(source: string): IntrinsicSize | undefined {
  const open = /^\s*<svg\b([^>]*)>/i.exec(source)?.[1];
  if (!open) return undefined;
  const width = svgLength(open, "width");
  const height = svgLength(open, "height");
  if (isPositive(width) && isPositive(height)) return { width: width!, height: height! };

  const viewBoxText = svgAttribute(open, "viewBox");
  const viewBox = viewBoxText?.trim().split(/[\s,]+/).map(Number);
  const viewWidth = viewBox?.[2];
  const viewHeight = viewBox?.[3];
  if (!isPositive(viewWidth) || !isPositive(viewHeight)) return undefined;
  if (isPositive(width)) return { width: width!, height: (width! * viewHeight!) / viewWidth! };
  if (isPositive(height)) return { width: (height! * viewWidth!) / viewHeight!, height: height! };
  // Replaced SVG images use the browser's 300px default intrinsic width when
  // only a viewBox is present; keep the pre-mount estimate on that same basis.
  return { width: 300, height: (300 * viewHeight!) / viewWidth! };
}

function svgLength(attributes: string, name: string): number | undefined {
  const value = svgAttribute(attributes, name);
  if (!value || /%\s*$/.test(value)) return undefined;
  const parsed = Number.parseFloat(value);
  return isPositive(parsed) ? parsed : undefined;
}

function svgAttribute(attributes: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(
    attributes
  );
  return match?.[1] ?? match?.[2];
}

class MediaMeasurementController {
  private readonly cache = new Map<string, IntrinsicSize>();
  private readonly probes = new Map<string, MediaProbe>();
  private readonly resizeObserver: ResizeObserver;
  private dispatchQueued = false;
  private queuedDimensions = new Map<string, IntrinsicSize>();
  private queuedLayout: { contentWidth: number; fontSizePx: number } | undefined;
  private queuedRetainIdentities: Set<string> | undefined;
  private publishedLayout: { contentWidth: number; fontSizePx: number } | undefined;
  private activeIdentities = new Set<string>();
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.resizeObserver = new ResizeObserver(() => this.measureLayout());
    this.resizeObserver.observe(this.view.contentDOM, { box: "content-box" });
    this.view.requestMeasure({
      read: () => readContentLayout(this.view),
      write: (layout) => this.queueEffect([], layout),
    });
    this.preloadDocumentMedia();
  }

  update(update: ViewUpdate): void {
    const mapChanged = update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(setImageMap))
    );
    const svgSourcesChanged =
      update.docChanged &&
      documentMeasurementScan(update.startState).svgSources !==
        documentMeasurementScan(update.state).svgSources;
    if (svgSourcesChanged || mapChanged) this.preloadDocumentMedia();
    if (update.geometryChanged) this.measureLayout();
  }

  record(src: string, width: number, height: number): void {
    if (this.destroyed) return;
    if (!isPositive(width) || !isPositive(height)) return;
    const identity = stableMediaIdentity(src);
    if (!this.activeIdentities.has(identity)) return;
    const previous = this.cache.get(identity);
    if (previous?.width === width && previous.height === height) return;
    this.cache.delete(identity);
    this.cache.set(identity, { width, height });
    this.queueEffect([{ identity, width, height }]);
  }

  private preloadDocumentMedia(): void {
    if (this.destroyed) return;
    const map = this.view.state.field(imageMapField, false) ?? {};
    const desired = new Map<string, string>();
    for (const source of Object.values(map).filter(Boolean)) {
      desired.set(source, stableMediaIdentity(source));
    }
    for (const source of documentMeasurementScan(this.view.state).svgSources) {
      const dataUri = sanitizedSvgDataUri(source);
      if (dataUri) desired.set(dataUri, svgMediaIdentity(source));
    }
    const missing = reconcileMediaProbeSources(
      this.probes,
      desired.keys(),
      (probe) => this.cancelProbe(probe)
    );
    this.activeIdentities = new Set(desired.values());
    for (const identity of this.cache.keys()) {
      if (!this.activeIdentities.has(identity)) this.cache.delete(identity);
    }
    this.queueEffect([], undefined, this.activeIdentities);
    for (const src of missing) this.preload(src, desired.get(src));
  }

  private preload(src: string, identity = stableMediaIdentity(src)): void {
    if (this.probes.has(src)) return;
    const image = new Image();
    const onLoad = (): void => {
      this.recordIdentity(identity, image.naturalWidth, image.naturalHeight);
    };
    const onError = (): void => {
      this.probes.delete(src);
    };
    const probe = { image, onLoad, onError };
    this.probes.set(src, probe);
    image.addEventListener("load", onLoad, { once: true });
    image.addEventListener("error", onError, { once: true });
    image.src = src;
  }

  private cancelProbe(probe: MediaProbe): void {
    probe.image.removeEventListener("load", probe.onLoad);
    probe.image.removeEventListener("error", probe.onError);
    probe.image.src = "";
  }

  private recordIdentity(identity: string, width: number, height: number): void {
    if (this.destroyed) return;
    if (!this.activeIdentities.has(identity)) return;
    if (!isPositive(width) || !isPositive(height)) return;
    const previous = this.cache.get(identity);
    if (previous?.width === width && previous.height === height) return;
    this.cache.delete(identity);
    this.cache.set(identity, { width, height });
    this.queueEffect([{ identity, width, height }]);
  }

  private measureLayout(): void {
    if (this.destroyed) return;
    this.view.requestMeasure({
      read: () => readContentLayout(this.view),
      write: (layout) => this.queueEffect([], layout),
    });
  }

  private queueEffect(
    dimensions: readonly { identity: string; width: number; height: number }[],
    layout?: { contentWidth: number; fontSizePx: number },
    retainIdentities?: ReadonlySet<string>
  ): void {
    for (const item of dimensions) {
      this.queuedDimensions.set(item.identity, { width: item.width, height: item.height });
    }
    if (
      layout &&
      (layout.contentWidth !== this.publishedLayout?.contentWidth ||
        layout.fontSizePx !== this.publishedLayout?.fontSizePx)
    ) {
      this.queuedLayout = layout;
    }
    if (retainIdentities) this.queuedRetainIdentities = new Set(retainIdentities);
    if (
      this.queuedDimensions.size === 0 &&
      !this.queuedLayout &&
      !this.queuedRetainIdentities
    ) return;
    if (this.dispatchQueued) return;
    this.dispatchQueued = true;
    queueMicrotask(() => {
      this.dispatchQueued = false;
      if (this.destroyed) return;
      const entries = [...this.queuedDimensions].map(([identity, size]) => ({ identity, ...size }));
      this.queuedDimensions.clear();
      const pendingLayout = this.queuedLayout;
      this.queuedLayout = undefined;
      const retain = this.queuedRetainIdentities;
      this.queuedRetainIdentities = undefined;
      if (pendingLayout) this.publishedLayout = pendingLayout;
      this.view.dispatch({
        effects: setMediaMeasurements.of({
          dimensions: entries,
          contentWidth: pendingLayout?.contentWidth,
          fontSizePx: pendingLayout?.fontSizePx,
          retainIdentities: retain ? [...retain] : undefined,
        }),
      });
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver.disconnect();
    destroyMediaProbes(this.probes, (probe) => this.cancelProbe(probe));
    this.activeIdentities.clear();
    this.queuedDimensions.clear();
    this.queuedLayout = undefined;
    this.queuedRetainIdentities = undefined;
  }
}

interface MediaProbe {
  image: HTMLImageElement;
  onLoad: () => void;
  onError: () => void;
}

function readContentLayout(view: EditorView): { contentWidth: number; fontSizePx: number } {
  const rect = view.contentDOM.getBoundingClientRect();
  const style = getComputedStyle(view.contentDOM);
  const horizontal =
    px(style.paddingLeft) +
    px(style.paddingRight) +
    px(style.borderLeftWidth) +
    px(style.borderRightWidth);
  return {
    contentWidth: Math.max(1, rect.width - horizontal),
    fontSizePx: px(style.fontSize),
  };
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isPositive(value: number | undefined): boolean {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

export const mediaMeasurementsPlugin = ViewPlugin.fromClass(MediaMeasurementController);

export function reportLoadedMedia(
  view: EditorView,
  src: string,
  width: number,
  height: number
): void {
  view.plugin(mediaMeasurementsPlugin)?.record(src, width, height);
}

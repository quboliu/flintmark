import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { imageMapField, setImageMap } from "./widgets/imageWidget";
import { sanitizedSvgDataUri } from "./widgets/svgWidget";

const MAX_MEDIA_CACHE_ENTRIES = 512;

export interface IntrinsicSize {
  width: number;
  height: number;
}

interface MediaMeasurementEffect {
  dimensions?: readonly { identity: string; width: number; height: number }[];
  contentWidth?: number;
  fontSizePx?: number;
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
        while (dimensions.size > MAX_MEDIA_CACHE_ENTRIES) {
          dimensions.delete(dimensions.keys().next().value!);
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
  try {
    const url = new URL(src);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return src.replace(/[?#].*$/, "");
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
  private readonly probes = new Map<string, HTMLImageElement>();
  private readonly resizeObserver: ResizeObserver;
  private dispatchQueued = false;
  private queuedDimensions = new Map<string, IntrinsicSize>();
  private queuedLayout: { contentWidth: number; fontSizePx: number } | undefined;
  private publishedLayout: { contentWidth: number; fontSizePx: number } | undefined;
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
    if (update.docChanged || mapChanged) this.preloadDocumentMedia();
    if (update.geometryChanged) this.measureLayout();
  }

  record(src: string, width: number, height: number): void {
    if (!isPositive(width) || !isPositive(height)) return;
    const identity = stableMediaIdentity(src);
    const previous = this.cache.get(identity);
    if (previous?.width === width && previous.height === height) return;
    this.cache.delete(identity);
    this.cache.set(identity, { width, height });
    while (this.cache.size > MAX_MEDIA_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    this.queueEffect([{ identity, width, height }]);
  }

  private preloadDocumentMedia(): void {
    if (this.destroyed) return;
    const map = this.view.state.field(imageMapField, false) ?? {};
    const sources = new Set(Object.values(map).filter(Boolean));
    const text = this.view.state.doc.toString();
    for (const match of text.matchAll(/<svg\b[\s\S]*?<\/svg\s*>/gi)) {
      const dataUri = sanitizedSvgDataUri(match[0]);
      if (dataUri) this.preload(dataUri, svgMediaIdentity(match[0]));
    }
    for (const src of sources) this.preload(src);
  }

  private preload(src: string, identity = stableMediaIdentity(src)): void {
    if (this.probes.has(src)) return;
    const probe = new Image();
    this.probes.set(src, probe);
    while (this.probes.size > MAX_MEDIA_CACHE_ENTRIES) {
      this.probes.delete(this.probes.keys().next().value!);
    }
    probe.addEventListener("load", () => {
      this.recordIdentity(identity, probe.naturalWidth, probe.naturalHeight);
    });
    probe.addEventListener("error", () => this.probes.delete(src), { once: true });
    probe.src = src;
  }

  private recordIdentity(identity: string, width: number, height: number): void {
    if (!isPositive(width) || !isPositive(height)) return;
    const previous = this.cache.get(identity);
    if (previous?.width === width && previous.height === height) return;
    this.cache.delete(identity);
    this.cache.set(identity, { width, height });
    while (this.cache.size > MAX_MEDIA_CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value!);
    }
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
    layout?: { contentWidth: number; fontSizePx: number }
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
    if (this.queuedDimensions.size === 0 && !this.queuedLayout) return;
    if (this.dispatchQueued) return;
    this.dispatchQueued = true;
    queueMicrotask(() => {
      this.dispatchQueued = false;
      if (this.destroyed) return;
      const entries = [...this.queuedDimensions].map(([identity, size]) => ({ identity, ...size }));
      this.queuedDimensions.clear();
      const pendingLayout = this.queuedLayout;
      this.queuedLayout = undefined;
      if (pendingLayout) this.publishedLayout = pendingLayout;
      this.view.dispatch({
        effects: setMediaMeasurements.of({
          dimensions: entries,
          contentWidth: pendingLayout?.contentWidth,
          fontSizePx: pendingLayout?.fontSizePx,
        }),
      });
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.resizeObserver.disconnect();
    this.probes.clear();
  }
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

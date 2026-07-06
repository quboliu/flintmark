// Renders a deliberately narrow subset of raw HTML blocks: a single inline SVG,
// optionally wrapped in a plain <div>. The SVG is sanitized and loaded through
// an <img data:> URL instead of inserted as live DOM.
import { EditorView, WidgetType } from "@codemirror/view";

const SVG_OPEN_RE = /<svg\b/gi;
const SVG_CLOSE_RE = /<\/svg\s*>/gi;
const PLAIN_DIV_RE = /^<div>\s*([\s\S]*?)\s*<\/div>$/i;

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "defs",
  "clipPath",
  "mask",
  "pattern",
  "linearGradient",
  "radialGradient",
  "stop",
  "marker",
  "use",
]);

const ALLOWED_ATTRS = new Set([
  "xmlns",
  "xmlns:xlink",
  "viewbox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "transform",
  "font-size",
  "font-family",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "id",
  "offset",
  "stop-color",
  "stop-opacity",
  "marker-start",
  "marker-mid",
  "marker-end",
  "clip-path",
  "mask",
  "href",
  "xlink:href",
]);

const LOCAL_REF_RE = /^#[A-Za-z_][\w:.-]*$/;
const LOCAL_URL_RE = /^url\(\s*(['"]?)#[A-Za-z_][\w:.-]*\1\s*\)$/i;

/**
 * Accept only:
 *   <svg>...</svg>
 * or:
 *   <div>
 *   <svg>...</svg>
 *   </div>
 *
 * This intentionally does not make Flintmark a general raw-HTML renderer.
 */
export function extractSvgFromHtmlBlock(source: string): string | null {
  let inner = source.trim();
  const div = PLAIN_DIV_RE.exec(inner);
  if (div) inner = div[1].trim();

  if (!/^<svg\b[\s\S]*<\/svg\s*>$/i.test(inner)) return null;
  const opens = inner.match(SVG_OPEN_RE)?.length ?? 0;
  const closes = inner.match(SVG_CLOSE_RE)?.length ?? 0;
  if (opens !== 1 || closes !== 1) return null;
  return inner;
}

function hasBlockedUrl(value: string): boolean {
  const compact = value.trim().replace(/[\u0000-\u001f\s]+/g, "").toLowerCase();
  if (/^(?:javascript|data|https?|file|blob|vscode|vscode-webview-resource):/.test(compact)) {
    return true;
  }
  const urls = value.match(/url\(\s*(['"]?)(.*?)\1\s*\)/gi) ?? [];
  return urls.some((url) => !LOCAL_URL_RE.test(url.trim()));
}

function attrAllowed(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith("on") || lower === "style") return false;
  if (!ALLOWED_ATTRS.has(lower)) return false;
  if (lower === "href" || lower === "xlink:href") return LOCAL_REF_RE.test(value.trim());
  if (hasBlockedUrl(value)) return false;
  return true;
}

function cloneSanitizedElement(source: Element, doc: XMLDocument): Element | null {
  const tag = source.localName;
  if (!ALLOWED_ELEMENTS.has(tag)) return null;

  const target = doc.createElementNS(SVG_NS, tag);
  for (const attr of Array.from(source.attributes)) {
    if (!attrAllowed(attr.name, attr.value)) continue;
    if (attr.name.toLowerCase() === "xlink:href") {
      target.setAttributeNS(XLINK_NS, "xlink:href", attr.value);
    } else {
      target.setAttribute(attr.name, attr.value);
    }
  }

  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(doc.createTextNode(child.textContent ?? ""));
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const clean = cloneSanitizedElement(child as Element, doc);
      if (clean) target.appendChild(clean);
    }
  }

  return target;
}

export function sanitizedSvgDataUri(svgSource: string): string | null {
  if (/<!doctype\b|<\?/i.test(svgSource)) return null;

  const parsed = new DOMParser().parseFromString(svgSource, "image/svg+xml");
  if (parsed.getElementsByTagName("parsererror").length > 0) return null;
  const root = parsed.documentElement;
  if (!root || root.localName !== "svg") return null;

  const cleanDoc = document.implementation.createDocument(SVG_NS, "svg", null);
  const cleanRoot = cloneSanitizedElement(root, cleanDoc);
  if (!cleanRoot) return null;
  cleanDoc.replaceChild(cleanRoot, cleanDoc.documentElement);
  const xml = new XMLSerializer().serializeToString(cleanRoot);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
}

export class SvgWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number
  ) {
    super();
  }

  eq(other: SvgWidget): boolean {
    return other.source === this.source && other.from === this.from;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("div");
    root.className = "ofm-svg-block";
    root.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.focus();
      view.dispatch({
        selection: { anchor: this.from },
        scrollIntoView: true,
      });
    });

    const dataUri = sanitizedSvgDataUri(this.source);
    if (!dataUri) {
      const pre = document.createElement("pre");
      pre.className = "ofm-svg-error";
      pre.textContent = this.source;
      root.appendChild(pre);
      return root;
    }

    const img = document.createElement("img");
    img.className = "ofm-svg-block-image";
    img.alt = "SVG diagram";
    img.addEventListener("load", () => view.requestMeasure());
    img.src = dataUri;
    root.appendChild(img);
    return root;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

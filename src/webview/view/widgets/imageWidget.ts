// Renders a Markdown image `![alt](src)` as an <img>. Reveal-gated (source shown
// while the cursor is inside). Local `src` paths are resolved to webview-safe
// URIs by the host and delivered via the imageMap state field — the host can't
// be queried synchronously from a widget, and images change as the user types,
// so the host re-sends the map and the decoration plugin rebuilds.
import { EditorView, WidgetType } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";

/** Host → webview: map of raw image src → resolved webview URI. */
export const setImageMap = StateEffect.define<Record<string, string>>();

export const imageMapField = StateField.define<Record<string, string>>({
  create: () => ({}),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setImageMap)) return e.value;
    }
    return value;
  },
});

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    /** Optional Obsidian `![[img.png|W]]` / `|WxH` dimensions, in px. */
    readonly width?: number,
    readonly height?: number
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.width === this.width &&
      other.height === this.height
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const img = document.createElement("img");
    img.className = "ofm-image";
    img.alt = this.alt;
    // Obsidian `|W` / `|WxH` sizing (px). Width only → keep aspect ratio.
    if (this.width !== undefined) img.width = this.width;
    if (this.height !== undefined) img.height = this.height;
    // The image loads asynchronously and changes the line height once decoded.
    // Tell CM6 to re-measure so its height map stays in sync (otherwise content
    // below the image is click/caret offset — the dynamic-height counterpart of
    // the no-margin rule).
    img.addEventListener("load", () => view.requestMeasure());
    if (this.src) img.src = this.src;
    return img;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

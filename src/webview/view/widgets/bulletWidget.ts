// Renders an unordered-list marker (-, *, +) as a styled bullet glyph.
// Reveal-gated by line: while the cursor is on the list line the raw marker is
// shown (natural editing); off the line, this bullet replaces it.
import { WidgetType } from "@codemirror/view";

export class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "ofm-list-bullet";
    span.textContent = "•";
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

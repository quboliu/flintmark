// Renders a Markdown thematic break (`---`/`***`/`___`) as a horizontal rule.
// Reveal-gated: when the cursor is on the line the raw source is shown instead.
import { WidgetType } from "@codemirror/view";

export class HrWidget extends WidgetType {
  eq(): boolean {
    return true; // stateless — all HR widgets are interchangeable
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "ofm-hr";
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

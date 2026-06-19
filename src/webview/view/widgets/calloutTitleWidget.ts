// When a callout has no custom title (`> [!note]` with nothing after the type),
// Obsidian shows the capitalized TYPE NAME as the title ("Note"). We replace the
// hidden `[!type]` marker with this widget so the title line isn't blank.
import { WidgetType } from "@codemirror/view";

export class CalloutTitleWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }

  eq(other: CalloutTitleWidget): boolean {
    return other.label === this.label;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "ofm-callout-default-title";
    span.textContent = this.label;
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// Inline widget for a note embed `![[Note]]`. v1 renders a clickable embed
// chip (opening the target via the host's link handler); full block-level
// transclusion of the target's rendered content is a future enhancement.
// Inline (not block) so it can live in the decoration ViewPlugin — CM6 forbids
// block decorations from plugins.
import { WidgetType } from "@codemirror/view";

export class EmbedWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly label: string
  ) {
    super();
  }

  eq(other: EmbedWidget): boolean {
    return other.target === this.target && other.label === this.label;
  }

  toDOM(): HTMLElement {
    const chip = document.createElement("span");
    chip.className = "ofm-embed ofm-internal-link";
    chip.setAttribute("data-ofm-link", this.target);
    chip.setAttribute("title", `Embed: ${this.target}`);

    const icon = document.createElement("span");
    icon.className = "ofm-embed-icon";
    icon.textContent = "📄";
    icon.setAttribute("aria-hidden", "true");
    chip.appendChild(icon);

    const text = document.createElement("span");
    text.textContent = this.label;
    chip.appendChild(text);

    return chip;
  }

  ignoreEvent(): boolean {
    // Let the click reach the editor's mousedown handler (opens the link).
    return false;
  }
}

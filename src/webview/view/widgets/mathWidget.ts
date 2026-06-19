// Renders $inline$ / $$display$$ math via KaTeX. Reveal-gated (source shown while
// the cursor is inside). KaTeX CSS + fonts are loaded via out/webview.css.
import { WidgetType } from "@codemirror/view";
import katex from "katex";

export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return other.tex === this.tex && other.display === this.display;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.display ? "ofm-math-block" : "ofm-math-inline";
    try {
      katex.render(this.tex, span, {
        displayMode: this.display,
        throwOnError: false,
      });
    } catch {
      span.textContent = this.tex; // never break the editor on a bad formula
    }
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

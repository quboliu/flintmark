// A small language label shown in the top-right corner of a fenced code block
// (positioned absolutely against the .ofm-codeblock-begin line). Mirrors
// Obsidian's code-block "flair".
import { WidgetType } from "@codemirror/view";

export class CodeLangWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }

  eq(other: CodeLangWidget): boolean {
    return other.lang === this.lang;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "ofm-code-lang";
    span.textContent = this.lang;
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

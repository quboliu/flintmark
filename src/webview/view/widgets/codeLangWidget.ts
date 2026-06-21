// The flair shown in a fenced code block's top-right corner: an optional
// language label plus a Copy button (Obsidian-style). Positioned absolutely
// against the .ofm-codeblock-begin line (see markdownTheme).
import { WidgetType } from "@codemirror/view";

export class CodeLangWidget extends WidgetType {
  constructor(
    readonly lang: string,
    /** The block's code text, copied to the clipboard by the Copy button. */
    readonly code: string = ""
  ) {
    super();
  }

  eq(other: CodeLangWidget): boolean {
    return other.lang === this.lang && other.code === this.code;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ofm-code-flair";

    if (this.lang) {
      const label = document.createElement("span");
      label.className = "ofm-code-lang";
      label.textContent = this.lang;
      label.setAttribute("aria-hidden", "true");
      wrap.appendChild(label);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ofm-code-copy";
    btn.textContent = "Copy";
    btn.title = "Copy code";
    btn.setAttribute("aria-label", "Copy code");
    const code = this.code;
    // Keep editor focus/selection stable; copy ourselves.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyToClipboard(code, btn);
    });
    wrap.appendChild(btn);

    return wrap;
  }

  ignoreEvent(): boolean {
    // The Copy button handles its own clicks; the editor shouldn't treat them
    // as cursor placement.
    return true;
  }
}

function flashCopied(btn: HTMLButtonElement): void {
  btn.classList.add("is-copied");
  btn.textContent = "Copied";
  setTimeout(() => {
    btn.classList.remove("is-copied");
    btn.textContent = "Copy";
  }, 1200);
}

function copyToClipboard(text: string, btn: HTMLButtonElement): void {
  try {
    const p = navigator.clipboard?.writeText(text);
    if (p && typeof p.then === "function") {
      p.then(() => flashCopied(btn)).catch(() => execCopy(text, btn));
    } else {
      execCopy(text, btn);
    }
  } catch {
    execCopy(text, btn);
  }
}

/** Fallback for webview contexts where navigator.clipboard is unavailable. */
function execCopy(text: string, btn: HTMLButtonElement): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    flashCopied(btn);
  } catch {
    /* best-effort */
  }
  document.body.removeChild(ta);
}

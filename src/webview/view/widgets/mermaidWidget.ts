// Renders a ```mermaid code block as a diagram. Mermaid (~3MB) is loaded lazily
// the first time a diagram appears: we inject out/mermaid.js (its webview URI and
// the CSP nonce are read from <meta> tags the host wrote). Reveal-gated — the
// raw source shows while the cursor is inside the block.
//
// HEIGHT CORRECTNESS: a block widget's height is taken from CM6's measurement at
// the time its DOM is created. Mermaid renders ASYNC, so a naive widget would be
// measured at its tiny "rendering…" height and never reliably re-measured →
// everything below the diagram drifts (click/caret offset). Fix: cache the
// rendered SVG, and once it's ready fire mermaidRenderedEffect so the block field
// REBUILDS; the rebuilt widget (rendered=true) is !eq to the placeholder, so CM6
// re-creates it and renders the SVG SYNCHRONOUSLY → measured at the final height.
import { EditorView, WidgetType } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";

interface MermaidApi {
  render(id: string, code: string): Promise<{ svg: string }>;
}

/** Fired once a diagram's SVG is cached, to make the block field rebuild. */
export const mermaidRenderedEffect = StateEffect.define<void>();

/** code → rendered SVG. Lets a re-created widget render synchronously. */
const svgCache = new Map<string, string>();

/** Whether a diagram's SVG is ready (so buildBlockWidgets can mark the widget). */
export function isMermaidRendered(code: string): boolean {
  return svgCache.has(code);
}

let mermaidPromise: Promise<MermaidApi | null> | null = null;

function loadMermaid(): Promise<MermaidApi | null> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = new Promise((resolve) => {
    const w = window as unknown as { __ofmMermaid?: MermaidApi };
    if (w.__ofmMermaid) {
      resolve(w.__ofmMermaid);
      return;
    }
    const meta = (name: string) =>
      document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "";
    const uri = meta("ofm-mermaid-uri");
    const nonce = meta("ofm-nonce");
    if (!uri) {
      resolve(null);
      return;
    }
    const script = document.createElement("script");
    script.src = uri;
    if (nonce) script.setAttribute("nonce", nonce);
    script.onload = () => resolve(w.__ofmMermaid ?? null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return mermaidPromise;
}

let renderSeq = 0;

export class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    /** True once the SVG is cached — flips eq() so CM6 re-creates (and thus
     *  re-measures) the widget at its final height. */
    readonly rendered: boolean
  ) {
    super();
  }

  eq(other: MermaidWidget): boolean {
    return other.code === this.code && other.rendered === this.rendered;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("div");
    container.className = "ofm-mermaid";

    const cached = svgCache.get(this.code);
    if (cached !== undefined) {
      // Synchronous render → CM6 measures the final height at construction.
      container.innerHTML = cached;
      return container;
    }

    container.textContent = "rendering diagram…";
    const code = this.code;
    void loadMermaid().then(async (mermaid) => {
      if (!mermaid) {
        showSource(container, code, "Mermaid failed to load");
        return;
      }
      try {
        const { svg } = await mermaid.render(`ofm-mermaid-${++renderSeq}`, code);
        svgCache.set(code, svg);
        container.innerHTML = svg;
        // Trigger a rebuild so CM6 re-creates this widget and re-measures it.
        view.dispatch({ effects: mermaidRenderedEffect.of() });
      } catch (e) {
        showSource(container, code, (e as Error)?.message ?? String(e));
      }
    });

    return container;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function showSource(container: HTMLElement, code: string, err: string): void {
  container.innerHTML = "";
  const pre = document.createElement("pre");
  pre.className = "ofm-mermaid-error";
  pre.textContent = `mermaid: ${err}\n\n${code}`;
  container.appendChild(pre);
}

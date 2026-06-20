// A floating "Edit with AI" button that appears above a non-empty selection
// (Notion/Medium style). This is the RELIABLE trigger for the AI Selection
// Bridge: keyboard shortcuts (Mod-I etc.) are claimed by the host's own inline
// chat and never reach the webview, but mouse events always reach the focused
// iframe. (The ofm.editSelectionWithAI palette command is the keyboard path.)
//
// Managed OUTSIDE a ViewPlugin on purpose: CM6 disables a plugin (calls
// destroy) if its update() ever throws, which would silently remove the button.
// Here createEditor owns it and drives reposition() from the update listener,
// and reposition is defensively guarded so a stray error can't kill it.
import { EditorView } from "@codemirror/view";

export interface AiButtonHandle {
  reposition: () => void;
  destroy: () => void;
}

export function createAiButton(
  view: EditorView,
  onEdit: (range: { from: number; to: number }) => void,
  onAddToChat: (range: { from: number; to: number }) => void
): AiButtonHandle {
  const dom = document.createElement("div");
  dom.className = "ofm-ai-toolbar";
  dom.style.display = "none";

  const mkButton = (
    label: string,
    aria: string,
    handler: (r: { from: number; to: number }) => void
  ): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = "ofm-ai-button";
    b.textContent = label;
    b.setAttribute("aria-label", aria);
    // mousedown (not click) + preventDefault so the editor keeps the selection.
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = view.state.selection.main;
      handler({ from: r.from, to: r.to });
    });
    return b;
  };

  dom.appendChild(mkButton("Edit", "Edit selection with AI", onEdit));
  dom.appendChild(mkButton("Add to Chat", "Add selection to AI chat", onAddToChat));
  view.dom.appendChild(dom);

  const reposition = (): void => {
    try {
      const sel = view.state.selection.main;
      if (sel.empty) {
        dom.style.display = "none";
        return;
      }
      const coords = view.coordsAtPos(sel.from);
      if (!coords) {
        dom.style.display = "none";
        return;
      }
      const box = view.dom.getBoundingClientRect();
      const top = Math.max(2, coords.top - box.top - 30);
      const left = Math.max(2, Math.min(coords.left - box.left, box.width - 130));
      dom.style.display = "flex";
      dom.style.top = `${top}px`;
      dom.style.left = `${left}px`;
    } catch {
      dom.style.display = "none";
    }
  };

  return { reposition, destroy: () => dom.remove() };
}

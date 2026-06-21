// CM6 wiring for the formatting shortcuts and smart paste. The boundary math is
// in editActions.ts (pure, unit-tested); this file only turns it into Commands /
// a paste handler and dispatches transactions. Dispatched changes flow to the
// host through the normal updateListener edit path (createEditor.ts), so no extra
// host wiring is needed.
import { EditorView, type KeyBinding } from "@codemirror/view";
import type { Command } from "@codemirror/view";
import {
  toggleInlineWrap,
  makeLinkEdit,
  linkPasteTransform,
  type InlineEdit,
} from "./editActions";

function applyEdit(view: EditorView, edit: InlineEdit): boolean {
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: { anchor: edit.selFrom, head: edit.selTo },
    userEvent: "input.format",
    scrollIntoView: true,
  });
  return true;
}

/** Toggle a symmetric inline marker around the main selection. */
function wrapCommand(marker: string): Command {
  return (view) => {
    const { from, to } = view.state.selection.main;
    return applyEdit(view, toggleInlineWrap(view.state.doc.toString(), from, to, marker));
  };
}

const linkCommand: Command = (view) => {
  const { from, to } = view.state.selection.main;
  return applyEdit(view, makeLinkEdit(view.state.doc.toString(), from, to));
};

/** Keybindings for inline formatting. Placed before defaultKeymap so they win. */
export const formatKeymap: readonly KeyBinding[] = [
  { key: "Mod-b", run: wrapCommand("**"), preventDefault: true },
  { key: "Mod-i", run: wrapCommand("*"), preventDefault: true },
  { key: "Mod-e", run: wrapCommand("`"), preventDefault: true },
  { key: "Mod-Shift-x", run: wrapCommand("~~"), preventDefault: true },
  { key: "Mod-k", run: linkCommand, preventDefault: true },
];

/**
 * Smart paste: paste a URL over a non-empty selection → `[selection](url)`.
 * Returns true (and consumes the event) only when it transforms; otherwise false
 * so the editor's default paste runs.
 */
export function handlePasteLink(event: ClipboardEvent, view: EditorView): boolean {
  const clip = event.clipboardData?.getData("text/plain");
  if (!clip) return false;
  const sel = view.state.selection.main;
  if (sel.empty) return false;
  const selText = view.state.sliceDoc(sel.from, sel.to);
  const replacement = linkPasteTransform(selText, clip);
  if (replacement === null) return false;
  event.preventDefault();
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: replacement },
    selection: { anchor: sel.from + replacement.length },
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  return true;
}

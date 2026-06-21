import {
  EditorView,
  keymap,
  ViewUpdate,
} from "@codemirror/view";
import { EditorState, Annotation, Transaction } from "@codemirror/state";
import { defaultKeymap } from "@codemirror/commands";
import type { VaultData } from "../../shared/protocol";
import { search, searchKeymap } from "@codemirror/search";
import { syntaxHighlighting } from "@codemirror/language";
import {
  insertNewlineContinueMarkup,
  deleteMarkupBackward,
} from "@codemirror/lang-markdown";
import { ofmMarkdown, ofmHighlightStyle } from "../kernel/obsidianSyntax";
import type { DocChange } from "../../shared/protocol";
import { markdownDecorationsPlugin, blockWidgetsField } from "./markdownDecorations";
import { createAiButton, type AiButtonHandle } from "./aiSelectionButton";
import { markdownTheme } from "./markdownTheme";
import { taskToggleFacet } from "./widgets/checkboxWidget";
import { imageMapField } from "./widgets/imageWidget";
import { formatKeymap, handlePasteLink } from "./formatCommands";
import { markdownFolding } from "./folding";
import { markdownAutocomplete } from "./autocomplete";
import {
  imageFromPaste,
  imageFromDrop,
  queueImageSave,
  MAX_ATTACHMENT_BYTES,
  type AttachmentPoster,
} from "./attachmentPaste";

// ---------------------------------------------------------------------------
// Annotation: marks dispatches originated by the host so we don't re-send
// them as user edits (belt-and-suspenders with host-side echo suppression).
// ---------------------------------------------------------------------------

export const hostOrigin = Annotation.define<boolean>();

// ---------------------------------------------------------------------------
// Callbacks the editor needs from the webview shell
// ---------------------------------------------------------------------------

export interface EditorCallbacks {
  /** Called for user-originated document changes (NOT host-originated). */
  onUserEdit: (changes: DocChange[]) => void;
  /** Called when the user presses Mod-z (undo) — relay to host. */
  onRequestUndo: () => void;
  /** Called when the user presses Mod-Shift-z or Mod-y (redo) — relay to host. */
  onRequestRedo: () => void;
  /** Called when a task checkbox is clicked — relay to host to toggle [ ]/[x]. */
  onToggleTask: (range: { from: number; to: number }) => void;
  /** Called when an internal (wiki) link is clicked — relay to host to open it. */
  onOpenLink: (target: string) => void;
  /** Called to bridge the current selection to source for native AI inline edit. */
  onRequestAiEdit: (range: { from: number; to: number }) => void;
  /** Called to bridge the current selection to source and add it to the AI chat. */
  onRequestAddToChat: (range: { from: number; to: number }) => void;
  /** Latest vault data (note names + tags) for `[[` / `#` autocomplete. */
  getVaultData: () => VaultData;
  /** Called to save a pasted/dropped image; the host replies via attachmentSaved. */
  onSaveAttachment: AttachmentPoster;
  /** Called to show the user a warning the webview can't surface itself. */
  onNotify: (message: string) => void;
}

const MAX_ATTACHMENT_MB = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));

/** The current selection (or caret position) as document offsets. */
export function currentSelectionRange(view: EditorView): { from: number; to: number } {
  const r = view.state.selection.main;
  return { from: r.from, to: r.to };
}

// ---------------------------------------------------------------------------
// Create the CM6 EditorView with Markdown language, Live Preview decorations,
// and document sync to the TextDocument authority (ADR-0002).
// ---------------------------------------------------------------------------

export function createEditor(
  parent: HTMLElement,
  initialText: string,
  callbacks: EditorCallbacks
): EditorView {
  const undoRedoKeymap = keymap.of([
    {
      key: "Mod-z",
      run: () => {
        callbacks.onRequestUndo();
        return true;
      },
      preventDefault: true,
    },
    {
      key: "Mod-Shift-z",
      run: () => {
        callbacks.onRequestRedo();
        return true;
      },
      preventDefault: true,
    },
    {
      key: "Mod-y",
      run: () => {
        callbacks.onRequestRedo();
        return true;
      },
      preventDefault: true,
    },
  ]);

  // Assigned after view creation; referenced by the update listener above.
  let aiButton: AiButtonHandle | null = null;

  const view = new EditorView({
    state: EditorState.create({
      doc: initialText,
      extensions: [
        // Markdown-aware Enter/Backspace: continue list/quote markers on Enter,
        // and remove them on Backspace at the line start (before defaultKeymap
        // so these win for those keys).
        keymap.of([
          { key: "Enter", run: insertNewlineContinueMarkup },
          { key: "Backspace", run: deleteMarkupBackward },
        ]),

        // Inline formatting shortcuts (Mod-b/i/e, Mod-Shift-x, Mod-k) — before
        // defaultKeymap so they win for those keys.
        keymap.of([...formatKeymap]),

        // Basic editing keys (Enter, Backspace, Delete, arrows, etc.)
        keymap.of(defaultKeymap),

        // Undo/Redo relayed to the TextDocument via the host (ADR-0002).
        undoRedoKeymap,

        // In-editor find/replace (Mod-F / Mod-Alt-F) — VS Code's native Find
        // can't reach into the webview, so the editor provides its own.
        search({ top: true }),
        keymap.of(searchKeymap),

        EditorView.lineWrapping,

        // Heading/section folding (gutter + Ctrl-Shift-[ / ]).
        markdownFolding,

        // [[wikilink]] / #tag / [[#heading]] autocomplete (vault-index backed).
        markdownAutocomplete(callbacks.getVaultData),

        // Markdown language: GFM + Obsidian inline syntax (wikilink/tag/==) — ADR-0003.
        ofmMarkdown(),

        // Syntax highlighting for fenced code (tags → Obsidian .cm-* classes).
        syntaxHighlighting(ofmHighlightStyle),

        // Live Preview: hide markers, style headings, apply inline styling.
        markdownDecorationsPlugin,

        // Block widgets (mermaid diagrams, tables) — must be a StateField.
        blockWidgetsField,

        // CSS theme for OFM-specific classes.
        markdownTheme,

        // Provide the task-toggle callback to checkbox widgets.
        taskToggleFacet.of(callbacks.onToggleTask),

        // Holds host-resolved image URIs (raw src -> webview URI).
        imageMapField,

        // Click a link (wiki [[…]] or external [text](url) / <url>) → ask the
        // host to open it. The host decides internal-note vs external-URL.
        EditorView.domEventHandlers({
          mousedown: (event) => {
            const el = event.target as HTMLElement | null;
            const link = el?.closest?.("[data-ofm-link]");
            const href = link?.getAttribute("data-ofm-link");
            if (href) {
              callbacks.onOpenLink(href);
              return true;
            }
            return false;
          },
          // Paste: an image → save as an attachment and insert ![[name]];
          // otherwise a URL over a selection → [selection](url); else default.
          paste: (event, view) => {
            const img = imageFromPaste(event);
            if (img) {
              event.preventDefault();
              const sel = view.state.selection.main;
              // Replace the selection (like a normal paste); a caret if empty.
              if (!queueImageSave(img, { from: sel.from, to: sel.to }, callbacks.onSaveAttachment)) {
                callbacks.onNotify(`Image is too large to attach (max ${MAX_ATTACHMENT_MB} MB).`);
              }
              return true;
            }
            return handlePasteLink(event, view);
          },
          // Drop an image file → save as an attachment at the drop point.
          drop: (event, view) => {
            const img = imageFromDrop(event);
            if (!img) return false;
            event.preventDefault();
            const at =
              view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
              view.state.selection.main.head;
            if (!queueImageSave(img, { from: at, to: at }, callbacks.onSaveAttachment)) {
              callbacks.onNotify(`Image is too large to attach (max ${MAX_ATTACHMENT_MB} MB).`);
            }
            return true;
          },
        }),

        // Listen for user edits: only forward transactions that
        // (a) change the document, and
        // (b) were NOT originated by the host (hostOrigin annotation).
        EditorView.updateListener.of((update: ViewUpdate) => {
          // Keep the floating AI button glued to the selection.
          if (update.selectionSet || update.docChanged || update.geometryChanged) {
            aiButton?.reposition();
          }
          if (!update.docChanged) return;
          for (const tr of update.transactions) {
            if (tr.annotation(hostOrigin)) continue;
            callbacks.onUserEdit(extractChanges(tr));
          }
        }),
      ],
    }),
    parent,
  });

  // Floating selection toolbar (Edit with AI / Add to Chat) — created after the
  // view (not as a ViewPlugin, which CM6 would tear down if any update() threw).
  aiButton = createAiButton(view, callbacks.onRequestAiEdit, callbacks.onRequestAddToChat);
  aiButton.reposition();

  return view;
}

// ---------------------------------------------------------------------------
// Extract minimal-range DocChange[] from a CM6 Transaction.
// ---------------------------------------------------------------------------

export function extractChanges(tr: Transaction): DocChange[] {
  const changes: DocChange[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    changes.push({
      from: fromA,
      to: toA,
      insert: inserted.toString(),
    });
  });
  return changes;
}

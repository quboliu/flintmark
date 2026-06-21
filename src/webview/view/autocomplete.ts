// Autocomplete for `[[wikilinks]]`, `#tags`, and `[[#headings]]` (current note),
// backed by the host's vault index (note names + tags pushed to the webview) and
// the live document (headings). The trigger/decision logic is a pure function
// (analyzeCompletion) so it unit-tests at L1; this module turns it into a CM6
// completion source. Cross-note `[[Note#heading]]` headings are intentionally
// out of scope (would need per-note heading data) — left for a later pass.
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";
import type { Completion, CompletionSource } from "@codemirror/autocomplete";
import { keymap } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import type { VaultData } from "../../shared/protocol";

/** What the cursor context wants completed. */
export interface CompletionQuery {
  kind: "wikilink" | "heading" | "tag";
  /** The text already typed for the candidate (used to filter). */
  query: string;
  /** Column (within the line) where the replaceable text starts. */
  from: number;
  /** Text to append after the inserted value (e.g. `]]`), or "". */
  close: string;
}

/**
 * Decide what (if anything) to complete given the line text before the cursor
 * and the two chars after it. Pure — no CM6/DOM. Returns null when the cursor
 * isn't in a completable spot.
 */
export function analyzeCompletion(before: string, after: string): CompletionQuery | null {
  // [[ wikilink … ]] (optionally with a #heading)
  const wl = /\[\[([^[\]\n]*)$/.exec(before);
  if (wl) {
    const inner = wl[1];
    const openAt = before.length - inner.length; // column right after `[[`
    const hash = inner.indexOf("#");
    const close = after.startsWith("]]") ? "" : "]]";
    if (hash >= 0) {
      // `[[#…` → current-note headings. `[[Note#…` (cross-note) is out of scope.
      if (inner.slice(0, hash).trim() !== "") return null;
      return { kind: "heading", query: inner.slice(hash + 1), from: openAt + hash + 1, close };
    }
    return { kind: "wikilink", query: inner, from: openAt, close };
  }

  // #tag — preceded by start-of-line or a non-word char (so `C#`/`a#b` don't
  // trigger), with at least one tag char typed (so a bare `#`/`## ` heading
  // doesn't pop the tag list).
  const tg = /(?:^|[\s([{>])#([\w/-]+)$/.exec(before);
  if (tg) {
    const q = tg[1];
    return { kind: "tag", query: q, from: before.length - q.length, close: "" };
  }

  return null;
}

/** Extract heading titles (ATX `#…` and Setext `Title`/`===`/`---`) from a
 *  document, ignoring `#`/underlines inside fenced code. */
export function docHeadings(text: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx) {
      out.push(atx[2].trim());
      continue;
    }
    // Setext: a non-blank text line immediately underlined by === or ---.
    const next = lines[i + 1];
    if (
      next !== undefined &&
      /\S/.test(line) &&
      !/^\s*#/.test(line) &&
      (/^=+\s*$/.test(next) || /^-+\s*$/.test(next))
    ) {
      out.push(line.trim());
      i++; // skip the underline row
    }
  }
  return [...new Set(out)];
}

const VALID_FOR: Record<CompletionQuery["kind"], RegExp> = {
  // `#` is excluded so typing it re-runs the source — `[[` (notes) then `[[#`
  // must switch to heading completion instead of reusing the note list.
  wikilink: /[^[\]#\n]*/,
  heading: /[^[\]\n]*/,
  tag: /[\w/-]*/,
};

/**
 * Build the autocomplete extension. `getData` returns the latest vault data
 * (notes + tags) — the webview updates it as the host pushes refreshes.
 */
export function markdownAutocomplete(getData: () => VaultData): Extension {
  const source: CompletionSource = (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const before = context.state.sliceDoc(line.from, context.pos);
    const after = context.state.sliceDoc(context.pos, Math.min(context.pos + 2, line.to));
    const q = analyzeCompletion(before, after);
    if (!q) return null;

    let options: Completion[];
    if (q.kind === "tag") {
      options = getData().tags.map((t) => ({ label: t, type: "keyword" }));
    } else if (q.kind === "heading") {
      options = docHeadings(context.state.doc.toString()).map((h) => ({
        label: h,
        type: "text",
        apply: h + q.close,
      }));
    } else {
      options = getData().notes.map((n) => ({
        label: n,
        type: "class",
        apply: n + q.close,
      }));
    }
    if (options.length === 0) return null;
    return { from: line.from + q.from, options, validFor: VALID_FOR[q.kind] };
  };

  return [
    autocompletion({ override: [source], icons: false, activateOnTyping: true }),
    // Accept/navigate keys win over the editor's Enter/Tab while the popup is open.
    Prec.highest(keymap.of(completionKeymap)),
  ];
}

/*
 * Reveal rule — pure function, host-independent (no vscode, no DOM, no CM6).
 * Docs: CONTEXT.md "Reveal", docs/02-technical-points.md §4, ADR-0005.
 *
 * Node-intersection rule: a construct's markers are revealed (shown as raw
 * Markdown source) iff *any* cursor/selection range touches the construct's
 * source range.  Same-line neighbours that aren't touched are unaffected.
 *
 * Touch is CLOSED-interval: sel.from <= B.to AND sel.to >= B.from. Touching a
 * boundary DOES reveal. This is deliberate (refined after L3 testing): a cursor
 * at the very start/end of a heading line must reveal it (a heading construct
 * spans the whole line, so its end == line end), and a cursor sitting
 * immediately before/after an inline construct reveals it — matching Obsidian.
 * Cursors strictly outside the construct leave it hidden.
 */

export interface SelectionRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Returns true iff any selection range intersects the construct range.
 * The construct range is the entire Markdown construct (e.g. `**bold**`
 * includes both markers), NOT just the visible content.
 */
export function shouldRevealConstruct(
  constructFrom: number,
  constructTo: number,
  selections: readonly SelectionRange[]
): boolean {
  for (const sel of selections) {
    if (sel.from <= constructTo && sel.to >= constructFrom) {
      return true;
    }
  }
  return false;
}

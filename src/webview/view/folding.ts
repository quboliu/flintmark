// Heading/section folding for the Live Preview. A heading folds away everything
// down to (but not including) the next heading of the same-or-higher level — the
// usual "collapse this section" behavior. The range math is a pure helper
// (unit-tested); the CM6 foldService gates on the syntax tree so a `#` inside a
// fenced code block is never treated as a heading.
import { EditorView, keymap } from "@codemirror/view";
import {
  foldService,
  foldGutter,
  codeFolding,
  foldKeymap,
  syntaxTree,
} from "@codemirror/language";
import type { Extension, EditorState, Text } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

/** ATX heading level (1-6) for a line, or 0 if it isn't one. */
export function headingLevel(line: string): number {
  const m = /^(#{1,6})(?:\s|$)/.exec(line);
  return m ? m[1].length : 0;
}

const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Last line index (0-based, inclusive) of the section opened by the heading at
 * `startIdx` (level `level`), scanning downward and ignoring `#` lines inside
 * fenced code. Returns startIdx when the section has no body (nothing to fold).
 */
export function sectionFoldEndLine(
  lines: string[],
  startIdx: number,
  level: number
): number {
  let end = startIdx;
  let inFence = false;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) inFence = !inFence;
    if (!inFence) {
      const lv = headingLevel(lines[i]);
      if (lv > 0 && lv <= level) break;
    }
    end = i;
  }
  // Trailing blank lines shouldn't be swallowed into the fold.
  while (end > startIdx && lines[end].trim() === "") end--;
  return end;
}

/** Heading level (1-6) at a document offset via the syntax tree, or 0. */
function headingLevelAt(state: EditorState, pos: number): number {
  let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  for (; n; n = n.parent) {
    const m = /^ATXHeading(\d)$/.exec(n.name);
    if (m) return Number(m[1]);
  }
  return 0;
}

// Text values are immutable and shared by selection/layout-only transactions.
// Cache section boundaries by document identity without retaining old documents.
const sectionRanges = new WeakMap<Text, Map<number, { from: number; to: number } | null>>();

export function headingFoldRange(
  state: EditorState,
  lineStart: number
): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineStart);
  // Parse progress can change without changing Text, so always apply this gate.
  const level = headingLevelAt(state, line.from);
  if (level === 0) return null;

  let ranges = sectionRanges.get(state.doc);
  if (!ranges) sectionRanges.set(state.doc, (ranges = new Map()));
  if (ranges.has(line.from)) return ranges.get(line.from)!;

  let to = line.to;
  let offset = line.to + 1;
  let inFence = false;
  if (line.number < state.doc.lines) {
    // Visit only this section. Materializing every line for every heading made
    // a full-layout gutter refresh scale with headings times document length.
    for (const text of state.doc.iterLines(line.number + 1)) {
      if (FENCE_RE.test(text)) inFence = !inFence;
      if (!inFence) {
        const nextLevel = headingLevel(text);
        if (nextLevel > 0 && nextLevel <= level) break;
      }
      if (text.trim() !== "") to = offset + text.length;
      offset += text.length + 1;
    }
  }
  const range = to > line.to ? { from: line.to, to } : null;
  ranges.set(line.from, range);
  return range;
}

const headingFoldService = foldService.of(headingFoldRange);

/** The folding extension bundle: enable folding, the gutter, heading ranges, keys. */
export const markdownFolding: Extension = [
  codeFolding(),
  headingFoldService,
  foldGutter({
    markerDOM(open) {
      const el = document.createElement("span");
      el.className = "ofm-fold-marker";
      el.textContent = open ? "▾" : "▸";
      return el;
    },
  }),
  keymap.of(foldKeymap),
  EditorView.baseTheme({
    ".ofm-fold-marker": { cursor: "pointer", opacity: "0.55", padding: "0 0.2em" },
    ".ofm-fold-marker:hover": { opacity: "1" },
  }),
];

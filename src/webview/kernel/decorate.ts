/*
 * Decoration plan — pure function mapping (marker metadata + selection) →
 * decoration descriptions.  Host-independent (no vscode, no DOM, no CM6).
 * Docs: ADR-0005, docs/03-solution-design.md §2 kernel/decorate.ts.
 *
 * The view layer feeds this function plain data extracted from the Lezer
 * syntax tree; this function decides which ranges to hide and which headings
 * to style, using reveal.ts for the node-intersection decision.
 */

import { shouldRevealConstruct, type SelectionRange } from "./reveal";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Plain-data Marker description extracted from the Lezer syntax tree. */
export interface MarkerInfo {
  /** Start offset of the marker in the document. */
  from: number;
  /** End offset (exclusive) of the marker in the document. */
  to: number;
  /** The full construct range containing this marker. */
  constructFrom: number;
  constructTo: number;
}

/** Plain-data description of a construct that has markers to potentially hide. */
export interface ConstructInfo {
  /** Full source range of the construct (including markers). */
  from: number;
  to: number;
  /** Marker ranges within this construct (1-2 for inline; 1 for heading). */
  markers: MarkerInfo[];
  /** Construct type key. */
  type: "heading" | "strong" | "emphasis" | "strikethrough" | "inlineCode";
  /** For headings: the level (1-6). Undefined for non-heading constructs. */
  headingLevel?: number;
}

/** A range to hide by replacing with empty. */
export interface HiddenRange {
  from: number;
  to: number;
}

/** A heading line-decoration instruction for the view layer. */
export interface HeadingStyle {
  /** Document offset anywhere on the heading line. View layer resolves to line number. */
  atOffset: number;
  /** Heading level 1-6. */
  level: number;
}

/** A marker that is SHOWN (construct revealed) and should be dimmed via the
 *  theme's `cm-formatting-*` classes (e.g. Things greys revealed `**`/`*`). */
export interface FormattingMarker {
  from: number;
  to: number;
  /** Space-separated CSS classes (`cm-formatting cm-formatting-strong`, …). */
  cls: string;
}

/** Complete decoration plan produced by this kernel function. */
export interface DecorationPlan {
  /** Markers to hide (replace with empty string). */
  hiddenRanges: HiddenRange[];
  /** Heading line-level CSS class assignments. */
  headingStyles: HeadingStyle[];
  /** Revealed markers to tag with `cm-formatting-*` so the theme dims them. */
  formattingMarkers: FormattingMarker[];
}

/** Map a construct type to its Obsidian `cm-formatting-*` marker class. */
function formattingClass(type: ConstructInfo["type"], level?: number): string {
  switch (type) {
    case "heading":
      return `cm-formatting cm-formatting-header cm-formatting-header-${level ?? 1}`;
    case "strong":
      return "cm-formatting cm-formatting-strong";
    case "emphasis":
      return "cm-formatting cm-formatting-em";
    case "strikethrough":
      return "cm-formatting cm-formatting-strikethrough";
    case "inlineCode":
      return "cm-formatting cm-formatting-code";
  }
}

// ---------------------------------------------------------------------------
// Kernel function
// ---------------------------------------------------------------------------

/**
 * Compute which markers to hide and which headings to style based on the
 * current selection.
 *
 * For each construct:
 * 1. If any selection range intersects the construct → REVEALED: do NOT hide
 *    its markers.
 * 2. If NOT revealed → add all markers to hiddenRanges.
 *
 * Heading line styling (level-based sizing) is ALWAYS output regardless of
 * reveal state.
 *
 * Fenced code blocks are NOT passed into this function — they are excluded
 * by the view layer before calling (code blocks never reveal per CONTEXT.md).
 */
export function computeDecorationPlan(
  constructs: ConstructInfo[],
  selections: readonly SelectionRange[]
): DecorationPlan {
  const hiddenRanges: HiddenRange[] = [];
  const headingStyles: HeadingStyle[] = [];
  const formattingMarkers: FormattingMarker[] = [];

  for (const c of constructs) {
    const revealed = shouldRevealConstruct(c.from, c.to, selections);

    for (const m of c.markers) {
      if (m.from >= m.to) continue;
      if (revealed) {
        // Shown while editing — dim via the theme's cm-formatting-* classes.
        formattingMarkers.push({
          from: m.from,
          to: m.to,
          cls: formattingClass(c.type, c.headingLevel),
        });
      } else {
        hiddenRanges.push({ from: m.from, to: m.to });
      }
    }

    // Heading level styling always applied.
    if (c.headingLevel !== undefined && c.headingLevel >= 1 && c.headingLevel <= 6) {
      headingStyles.push({
        atOffset: c.from,
        level: c.headingLevel,
      });
    }
  }

  return { hiddenRanges, headingStyles, formattingMarkers };
}

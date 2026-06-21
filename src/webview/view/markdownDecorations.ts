/*
 * CM6 ViewPlugin: walks the @lezer/markdown syntax tree, feeds kernel
 * functions (reveal + decorate), and produces DecorationSet for Live Preview.
 *
 * buildDecorations takes an EditorState (not a View) so it is exercisable in a
 * headless Node test (test/kernel/decorations.test.ts) — see ADR-0005.
 *
 * Decoration ordering:
 *   We collect all decorations (hidden markers, heading line styling, inline
 *   content marks) into one array and hand it to Decoration.set(decos, /*sort*\/
 *   true). RangeSetBuilder is intentionally NOT used: it requires the caller to
 *   add ranges already sorted by (from, startSide), and line decorations sort
 *   before replace/mark decorations at the same offset — mixing the three kinds
 *   across separate passes violated that and threw at runtime on any heading.
 *
 * Cursor-navigation over hidden marker ranges:
 *   Hidden markers use Decoration.replace({}) (zero-width invisible). CM6's
 *   default behaviour makes the cursor skip over replaced ranges on arrow keys.
 *   When the cursor enters the construct's visible content it intersects the
 *   construct range, the Reveal rule fires, and the markers become visible and
 *   editable again. (Atomic behaviour is CM6's default for replace; revisit if
 *   manual/L3 QA shows it feels wrong — docs/02 §4.)
 */

import { syntaxTree } from "@codemirror/language";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { EditorState, Range, StateField } from "@codemirror/state";
import type { SyntaxNodeRef } from "@lezer/common";
import { computeDecorationPlan, type ConstructInfo } from "../kernel/decorate";
import { shouldRevealConstruct, type SelectionRange } from "../kernel/reveal";
import { detectExtendedTask } from "./editActions";
import { BulletWidget } from "./widgets/bulletWidget";
import { CalloutTitleWidget } from "./widgets/calloutTitleWidget";
import { CheckboxWidget } from "./widgets/checkboxWidget";
import { CodeLangWidget } from "./widgets/codeLangWidget";
import { HrWidget } from "./widgets/hrWidget";
import { EmbedWidget } from "./widgets/embedWidget";
import { ImageWidget, imageMapField, setImageMap } from "./widgets/imageWidget";
import { MathWidget } from "./widgets/mathWidget";
import {
  MermaidWidget,
  mermaidRenderedEffect,
  isMermaidRendered,
} from "./widgets/mermaidWidget";
import { TableWidget } from "./widgets/tableWidget";
import { FrontmatterWidget } from "./widgets/frontmatterWidget";
import { parseFrontmatter } from "./frontmatter";

// ---------------------------------------------------------------------------
// Markdown node type names from @lezer/markdown (CommonMark + GFM)
// ---------------------------------------------------------------------------

// @lezer/markdown names ATX headings ATXHeading1..ATXHeading6 (there is no
// bare "Heading" node); the leading-hash mark is "HeaderMark" (not "Heading…").
const NODE_HEADING_PREFIX = "ATXHeading";
const NODE_STRONG_EMPHASIS = "StrongEmphasis";
const NODE_EMPHASIS = "Emphasis";
const NODE_STRIKETHROUGH = "Strikethrough";
const NODE_INLINE_CODE = "InlineCode";

const MARK_HEADING = "HeaderMark";
const MARK_EMPHASIS = "EmphasisMark";
const MARK_STRIKETHROUGH = "StrikethroughMark";
const MARK_CODE = "CodeMark";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getHeadingLevel(markFrom: number, markTo: number, docText: string): number {
  let count = 0;
  for (let i = markFrom; i < markTo; i++) {
    if (docText[i] === "#") count++;
    else break;
  }
  return Math.min(count, 6);
}

function buildHeadingConstruct(
  node: SyntaxNodeRef,
  docText: string
): ConstructInfo | null {
  let markFrom = -1;
  let markTo = -1;

  const cursor = node.node.cursor();
  if (!cursor.firstChild()) return null;
  do {
    if (cursor.type.name === MARK_HEADING) {
      markFrom = cursor.from;
      markTo = cursor.to;
      break;
    }
  } while (cursor.nextSibling());

  if (markFrom < 0 || markFrom >= markTo) return null;

  const level = getHeadingLevel(markFrom, markTo, docText);
  if (level < 1 || level > 6) return null;

  // Hide the heading marker AND the single space that follows it, so the
  // rendered heading text starts at the line edge (no leading gap).
  let hideTo = markTo;
  if (docText[hideTo] === " ") hideTo += 1;

  return {
    from: node.from,
    to: node.to,
    type: "heading",
    headingLevel: level,
    markers: [
      {
        from: markFrom,
        to: hideTo,
        constructFrom: node.from,
        constructTo: node.to,
      },
    ],
  };
}

function buildInlineConstruct(
  node: SyntaxNodeRef,
  type: ConstructInfo["type"],
  markName: string
): ConstructInfo | null {
  const markers: ConstructInfo["markers"] = [];

  const cursor = node.node.cursor();
  if (!cursor.firstChild()) return null;
  do {
    if (cursor.type.name === markName) {
      markers.push({
        from: cursor.from,
        to: cursor.to,
        constructFrom: node.from,
        constructTo: node.to,
      });
    }
  } while (cursor.nextSibling());

  if (markers.length === 0) return null;

  return {
    from: node.from,
    to: node.to,
    type,
    markers,
  };
}

// ---------------------------------------------------------------------------
// Collect all constructs from the syntax tree
// ---------------------------------------------------------------------------

function collectConstructs(
  tree: ReturnType<typeof syntaxTree>,
  docText: string,
  ranges: VisibleRange[]
): ConstructInfo[] {
  const constructs: ConstructInfo[] = [];

  const enter = (node: SyntaxNodeRef): void => {
    const name = node.type.name;

    if (name.startsWith(NODE_HEADING_PREFIX)) {
      const c = buildHeadingConstruct(node, docText);
      if (c) constructs.push(c);
    } else if (name === NODE_STRONG_EMPHASIS) {
      const c = buildInlineConstruct(node, "strong", MARK_EMPHASIS);
      if (c) constructs.push(c);
    } else if (name === NODE_EMPHASIS) {
      const c = buildInlineConstruct(node, "emphasis", MARK_EMPHASIS);
      if (c) constructs.push(c);
    } else if (name === NODE_STRIKETHROUGH) {
      const c = buildInlineConstruct(node, "strikethrough", MARK_STRIKETHROUGH);
      if (c) constructs.push(c);
    } else if (name === NODE_INLINE_CODE) {
      const c = buildInlineConstruct(node, "inlineCode", MARK_CODE);
      if (c) constructs.push(c);
    }
    // FencedCode: excluded — never reveal, fences never hidden (CONTEXT.md).
  };

  for (const r of ranges) tree.iterate({ from: r.from, to: r.to, enter });

  return constructs;
}

// ---------------------------------------------------------------------------
// Build DecorationSet from state (tree + selection)
// ---------------------------------------------------------------------------

/** A half-open document range to decorate. The ViewPlugin passes the editor's
 *  visibleRanges so per-keystroke cost is O(viewport), not O(document). */
export interface VisibleRange {
  from: number;
  to: number;
}

/** Hard ceiling: above this, decoration cost (string allocation + tree walk)
 *  outweighs the benefit even with viewport rendering, so fall back to plain
 *  source. Viewport rendering keeps decoration COUNT bounded, so this can be
 *  generous compared with the pre-viewport 300k cliff. */
const LARGE_FILE_CHARS = 2_000_000;

export function buildDecorations(
  state: EditorState,
  ranges?: VisibleRange[]
): DecorationSet {
  if (state.doc.length > LARGE_FILE_CHARS) return Decoration.none;
  const tree = syntaxTree(state);
  const docText = state.doc.toString();
  const imageMap = state.field(imageMapField, false) ?? {};
  // Default to the whole document so headless callers (the decoration unit
  // test, ADR-0005) get identical behaviour without a View.
  const visible: VisibleRange[] = ranges ?? [{ from: 0, to: state.doc.length }];

  const selections: SelectionRange[] = state.selection.ranges.map((r) => ({
    from: r.from,
    to: r.to,
  }));

  const constructs = collectConstructs(tree, docText, visible);
  const plan = computeDecorationPlan(constructs, selections);

  // Collect every decoration into one array, then let Decoration.set sort it
  // (sort=true) — avoids the strict add-order contract of RangeSetBuilder.
  const decos: Range<Decoration>[] = [];

  // 0. Frontmatter (--- … ---) at the top: dim it; its `---` are NOT rules.
  const fmEnd = addFrontmatterDecorations(state, docText, decos);

  // 1. Hide markers (replace with empty).
  for (const h of plan.hiddenRanges) {
    decos.push(Decoration.replace({}).range(h.from, h.to));
  }

  // 1b. Revealed markers (cursor inside the construct): tag them with Obsidian's
  //     cm-formatting-* classes so the theme dims them (Things greys `**`/`*`/`#`).
  for (const f of plan.formattingMarkers) {
    decos.push(Decoration.mark({ class: f.cls }).range(f.from, f.to));
  }

  // 1c. Obsidian `%%comments%%` — hidden in preview, revealed (raw) while the
  //     cursor is inside so they stay editable. Inline → replace the span;
  //     multi-line → collapse each line (replace can't span newlines in CM6).
  for (const c of findComments(docText)) {
    if (shouldRevealConstruct(c.from, c.to, selections)) continue;
    const sLine = state.doc.lineAt(c.from);
    const eLine = state.doc.lineAt(c.to);
    if (sLine.number === eLine.number) {
      decos.push(Decoration.replace({}).range(c.from, c.to));
    } else {
      for (let n = sLine.number; n <= eLine.number; n++) {
        const ln = state.doc.line(n);
        decos.push(Decoration.line({ class: "ofm-hidden-line" }).range(ln.from));
      }
    }
  }

  // 1d. Footnotes — `[^1]` refs and `[^1]:` definitions: superscript the label
  //     and hide the `[^`…`]`/`]:` syntax (reveal-gated for editing).
  for (const fn of findFootnotes(docText)) {
    if (shouldRevealConstruct(fn.from, fn.to, selections)) continue;
    decos.push(Decoration.replace({}).range(fn.from, fn.idFrom)); // `[^`
    decos.push(Decoration.replace({}).range(fn.idTo, fn.to)); // `]` or `]:`
    if (fn.idFrom < fn.idTo) {
      decos.push(Decoration.mark({ class: "ofm-footnote-ref" }).range(fn.idFrom, fn.idTo));
    }
  }

  // 2. Line-level heading styling. Also carry Obsidian's heading classes so
  //    bundled themes (which target .HyperMD-header-N / .cm-header-N) style them.
  for (const hs of plan.headingStyles) {
    const line = state.doc.lineAt(hs.atOffset);
    decos.push(
      Decoration.line({
        // The base `HyperMD-header` class is REQUIRED by themes' compound
        // selectors (.HyperMD-header.HyperMD-header-N.cm-line) — without it
        // Things' H2 underline etc. never match.
        class: `ofm-heading-${hs.level} HyperMD-header HyperMD-header-${hs.level} cm-header-${hs.level}`,
      }).range(line.from)
    );
  }

  // 3. Inline content styling (always on, regardless of reveal).
  const inlineEnter = (node: SyntaxNodeRef): void => {
    // Frontmatter is YAML, not Markdown — never apply inline Markdown styling
    // inside it (that's what made `- x` / numbers render as list/colored).
    if (node.from < fmEnd) return;
    const name = node.type.name;
    // Carry Obsidian's cm-* token classes so the active theme (Things) colors
    // them — e.g. cm-strong/cm-em are how Things applies its signature pink.
    if (name === NODE_STRONG_EMPHASIS) {
      addInlineContentDecor(decos, node, "ofm-strong cm-strong");
    } else if (name === NODE_EMPHASIS) {
      addInlineContentDecor(decos, node, "ofm-emphasis cm-em");
    } else if (name === NODE_STRIKETHROUGH) {
      addInlineContentDecor(decos, node, "ofm-strikethrough cm-strikethrough");
    } else if (name === NODE_INLINE_CODE) {
      addInlineContentDecor(decos, node, "ofm-inline-code cm-inline-code");
    }
  };
  for (const r of visible) tree.iterate({ from: r.from, to: r.to, enter: inlineEnter });

  // 4. Task checkboxes: replace [ ] / [x] markers with interactive checkboxes
  //    (always shown, not reveal-gated — matches Obsidian).
  // 5. Callouts (styled blockquotes) and horizontal rules.
  const blockEnter = (node: SyntaxNodeRef): void => {
    {
      // Frontmatter is YAML — skip block Markdown (lists/bullets, etc.) inside it.
      if (node.from < fmEnd) return;
      const name = node.type.name;
      if (name === "TaskMarker") {
        const marker = docText.slice(node.from, node.to);
        const taskChar = marker.length >= 2 ? marker[1] : " ";
        const checked = /[xX]/.test(taskChar);
        decos.push(
          Decoration.replace({
            widget: new CheckboxWidget(checked, node.from, node.to, taskChar),
          }).range(node.from, node.to)
        );
        // Tag the task line so the theme can style/dim by task type
        // (e.g. Things dims completed `[x]` tasks).
        const taskLine = state.doc.lineAt(node.from);
        decos.push(
          Decoration.line({
            class: "HyperMD-task-line",
            attributes: { "data-task": taskChar },
          }).range(taskLine.from)
        );
      } else if (name === "Blockquote") {
        addBlockquoteDecorations(node, state, selections, decos);
      } else if (name === "SetextHeading1" || name === "SetextHeading2") {
        addSetextHeadingDecorations(
          node,
          name === "SetextHeading1" ? 1 : 2,
          state,
          selections,
          decos
        );
      } else if (name === "FencedCode") {
        addFencedCodeDecorations(node, state, docText, selections, decos);
      } else if (name === "HorizontalRule") {
        if (
          node.from >= fmEnd &&
          !shouldRevealConstruct(node.from, node.to, selections)
        ) {
          decos.push(
            Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to)
          );
        }
      } else if (name === "ListMark") {
        addListMarkDecoration(node, state, docText, selections, decos);
      } else if (name === "Tag") {
        decos.push(
          Decoration.mark({ class: "ofm-tag cm-hashtag cm-meta" }).range(node.from, node.to)
        );
      } else if (name === "Highlight") {
        if (node.to - 2 > node.from + 2) {
          decos.push(
            Decoration.mark({ class: "ofm-highlight cm-highlight" }).range(
              node.from + 2,
              node.to - 2
            )
          );
        }
        if (!shouldRevealConstruct(node.from, node.to, selections)) {
          decos.push(Decoration.replace({}).range(node.from, node.from + 2));
          decos.push(Decoration.replace({}).range(node.to - 2, node.to));
        }
      } else if (name === "WikiLink") {
        addWikiLinkDecorations(node, docText, selections, decos);
      } else if (name === "Link") {
        addLinkDecorations(node, docText, selections, decos);
      } else if (name === "Autolink") {
        addAutolinkDecorations(node, docText, selections, decos);
      } else if (name === "Image") {
        addImageDecoration(node, docText, selections, imageMap, decos);
      } else if (name === "InlineMath" || name === "BlockMath") {
        if (!shouldRevealConstruct(node.from, node.to, selections)) {
          const display = name === "BlockMath";
          const inner = display
            ? docText.slice(node.from + 2, node.to - 2)
            : docText.slice(node.from + 1, node.to - 1);
          decos.push(
            Decoration.replace({ widget: new MathWidget(inner, display) }).range(
              node.from,
              node.to
            )
          );
        }
      }
    }
  };
  for (const r of visible) tree.iterate({ from: r.from, to: r.to, enter: blockEnter });

  return Decoration.set(decos, true);
}

/**
 * WikiLink `[[target]]` / `[[target|alias]]`: when not being edited, hide the
 * brackets (and `target|`) and render the alias/target as a clickable internal
 * link carrying the target in data-ofm-link. Shows raw source while the cursor
 * is inside.
 */
function addWikiLinkDecorations(
  node: SyntaxNodeRef,
  docText: string,
  selections: SelectionRange[],
  decos: Range<Decoration>[]
): void {
  const from = node.from;
  const to = node.to;
  if (shouldRevealConstruct(from, to, selections)) return;

  const inner = docText.slice(from + 2, to - 2);
  const pipe = inner.indexOf("|");
  const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
  const labelFrom = pipe >= 0 ? from + 2 + pipe + 1 : from + 2;
  const labelTo = to - 2;

  decos.push(Decoration.replace({}).range(from, labelFrom)); // [[  (and target|)
  decos.push(Decoration.replace({}).range(labelTo, to)); // ]]
  if (labelTo > labelFrom) {
    decos.push(
      Decoration.mark({
        class: "ofm-internal-link",
        attributes: { "data-ofm-link": target },
      }).range(labelFrom, labelTo)
    );
  }
}

/**
 * Regular Markdown link `[text](url)` (and `[text](url "title")`): when not
 * being edited, hide the `[` and the trailing `](url …)` and render the text as
 * a clickable external link carrying the URL in data-ofm-link. Reference-style
 * (`[text][ref]`) and shortcut (`[text]`) links lack an inline URL node, so they
 * are left as source. Inline formatting inside the text still renders (the text
 * range is only marked, not replaced).
 */
function addLinkDecorations(
  node: SyntaxNodeRef,
  docText: string,
  selections: SelectionRange[],
  decos: Range<Decoration>[]
): void {
  if (shouldRevealConstruct(node.from, node.to, selections)) return;

  const marks: { from: number; to: number }[] = [];
  let urlNode: { from: number; to: number } | null = null;
  const cur = node.node.cursor();
  if (!cur.firstChild()) return;
  do {
    if (cur.name === "LinkMark") marks.push({ from: cur.from, to: cur.to });
    else if (cur.name === "URL") urlNode = { from: cur.from, to: cur.to };
  } while (cur.nextSibling());

  // Inline links have ≥4 LinkMarks ( [ ] ( ) ) and a URL child.
  if (marks.length < 4 || !urlNode) return;
  const openBracket = marks[0]; // [
  const closeBracket = marks[1]; // ]
  const textFrom = openBracket.to;
  const textTo = closeBracket.from;
  if (textTo <= textFrom) return; // empty link text

  const url = docText.slice(urlNode.from, urlNode.to);
  decos.push(Decoration.replace({}).range(openBracket.from, openBracket.to)); // [
  decos.push(
    Decoration.mark({
      class: "ofm-external-link",
      attributes: { "data-ofm-link": url },
    }).range(textFrom, textTo)
  );
  decos.push(Decoration.replace({}).range(closeBracket.from, node.to)); // ](url …)
}

/** Autolink `<https://…>` / `<mailto:…>`: hide the angle brackets and render the
 *  URL as a clickable external link (reveal-gated). */
function addAutolinkDecorations(
  node: SyntaxNodeRef,
  docText: string,
  selections: SelectionRange[],
  decos: Range<Decoration>[]
): void {
  if (shouldRevealConstruct(node.from, node.to, selections)) return;
  if (node.to - node.from <= 2) return;
  const inner = docText.slice(node.from + 1, node.to - 1);
  decos.push(Decoration.replace({}).range(node.from, node.from + 1)); // <
  decos.push(Decoration.replace({}).range(node.to - 1, node.to)); // >
  decos.push(
    Decoration.mark({
      class: "ofm-external-link",
      attributes: { "data-ofm-link": inner },
    }).range(node.from + 1, node.to - 1)
  );
}

/**
 * List markers. Reveal-gated by LINE (the raw marker shows while the cursor is
 * on that line, for natural editing; otherwise it's projected):
 *   - task item (`- [ ]`): hide the `- ` so only the checkbox shows (the
 *     checkbox already replaces `[ ]`), matching Obsidian.
 *   - unordered (`-`/`*`/`+`): replace the marker char with a `•` bullet glyph
 *     (the trailing space is kept, so content alignment is preserved).
 *   - ordered (`1.`): left as source — the number carries meaning.
 */
function addListMarkDecoration(
  node: SyntaxNodeRef,
  state: EditorState,
  docText: string,
  selections: SelectionRange[],
  decos: Range<Decoration>[]
): void {
  const item = node.node.parent; // ListItem
  const list = item?.parent; // BulletList | OrderedList
  const ordered = list?.type.name === "OrderedList";

  // Reveal raw markdown while the cursor is anywhere on the marker's line.
  const line = state.doc.lineAt(node.from);
  if (shouldRevealConstruct(line.from, line.to, selections)) return;

  // Task item? (ListItem has a Task child.)
  let isTask = false;
  if (item) {
    const c = item.cursor();
    if (c.firstChild()) {
      do {
        if (c.type.name === "Task") {
          isTask = true;
          break;
        }
      } while (c.nextSibling());
    }
  }

  if (isTask) {
    let end = node.to;
    if (docText[end] === " ") end += 1; // also swallow the space before `[ ]`
    decos.push(Decoration.replace({}).range(node.from, end));
    return;
  }

  // Extended Obsidian task states ([/], [-], [>], [?], …): the GFM parser only
  // tags [ ] / [x] as Tasks, so detect the other single-char markers off the
  // list mark and render a checkbox + a data-task line for theme styling.
  const ext = detectExtendedTask(docText, node.to);
  if (ext) {
    decos.push(
      Decoration.replace({
        widget: new CheckboxWidget(false, ext.from, ext.to, ext.char),
      }).range(node.from, ext.to)
    );
    decos.push(
      Decoration.line({
        class: "HyperMD-task-line",
        attributes: { "data-task": ext.char },
      }).range(line.from)
    );
    return;
  }

  if (ordered) return; // keep the number

  decos.push(
    Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to)
  );
}

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * If the document opens with a YAML frontmatter block (--- … ---), dim its lines
 * and return its end offset (so the delimiter `---` lines are not rendered as
 * horizontal rules). Returns 0 when there is no frontmatter.
 */
function addFrontmatterDecorations(
  state: EditorState,
  docText: string,
  decos: Range<Decoration>[]
): number {
  const m = FRONTMATTER_RE.exec(docText);
  if (!m) return 0;
  const end = m[0].length;
  const firstLine = state.doc.lineAt(0);
  const lastLine = state.doc.lineAt(Math.max(0, end - 1));
  for (let n = firstLine.number; n <= lastLine.number; n++) {
    decos.push(
      Decoration.line({ class: "ofm-frontmatter" }).range(state.doc.line(n).from)
    );
  }
  return end;
}

/** Render `![alt](src)` as an image (reveal-gated); src resolved via imageMap. */
function addImageDecoration(
  node: SyntaxNodeRef,
  docText: string,
  selections: SelectionRange[],
  imageMap: Record<string, string>,
  decos: Range<Decoration>[]
): void {
  if (shouldRevealConstruct(node.from, node.to, selections)) return;
  const raw = docText.slice(node.from, node.to);

  // Obsidian embed `![[target]]` (Lezer parses it as an Image with no `(url)`):
  //   image target  → render the image; note target → clickable embed chip.
  const embed = /^!\[\[([^\]]+)\]\]$/.exec(raw);
  if (embed) {
    const inner = embed[1];
    const target = inner.split("|")[0].split("#")[0].trim();
    const label = (inner.includes("|") ? inner.split("|").slice(1).join("|") : target).trim();
    if (/\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i.test(target)) {
      const resolved = imageMap[target] ?? (/^(https?:|data:)/.test(target) ? target : "");
      // Obsidian sizing: the first `|` part may be `W` or `WxH` (px).
      const sizeM = /^(\d+)(?:x(\d+))?$/.exec(
        inner.includes("|") ? inner.split("|")[1].trim() : ""
      );
      const width = sizeM ? Number(sizeM[1]) : undefined;
      const height = sizeM && sizeM[2] ? Number(sizeM[2]) : undefined;
      const alt = sizeM ? target : label;
      decos.push(
        Decoration.replace({
          widget: new ImageWidget(resolved, alt, width, height),
        }).range(node.from, node.to)
      );
    } else {
      decos.push(
        Decoration.replace({ widget: new EmbedWidget(target, label) }).range(
          node.from,
          node.to
        )
      );
    }
    return;
  }

  const m = /^!\[([^\]]*)\]\(\s*([^)\s]+)/.exec(raw);
  if (!m) return;
  const alt = m[1];
  const src = m[2];
  const resolved = imageMap[src] ?? (/^(https?:|data:)/.test(src) ? src : "");
  decos.push(
    Decoration.replace({ widget: new ImageWidget(resolved, alt) }).range(
      node.from,
      node.to
    )
  );
}

/** Fenced code: render ```mermaid blocks as diagrams (reveal-gated); otherwise
 *  box the lines (source kept — no WYSIWYG for code, per CONTEXT.md). */
function addFencedCodeDecorations(
  node: SyntaxNodeRef,
  state: EditorState,
  docText: string,
  selections: SelectionRange[],
  decos: Range<Decoration>[]
): void {
  let lang = "";
  let codeFrom = -1;
  let codeTo = -1;
  const cur = node.node.cursor();
  if (cur.firstChild()) {
    do {
      if (cur.name === "CodeInfo") {
        lang = docText.slice(cur.from, cur.to).trim().toLowerCase();
      } else if (cur.name === "CodeText") {
        codeFrom = cur.from;
        codeTo = cur.to;
      }
    } while (cur.nextSibling());
  }

  if (
    lang === "mermaid" &&
    codeFrom >= 0 &&
    !shouldRevealConstruct(node.from, node.to, selections)
  ) {
    // The block widget is a BLOCK decoration — CM6 forbids those from a
    // ViewPlugin, so it's provided by mermaidBlockField (a StateField) instead.
    return;
  }

  const open = state.doc.lineAt(node.from); // ```lang
  const close = state.doc.lineAt(Math.max(node.from, node.to - 1)); // ```
  const revealed = shouldRevealConstruct(node.from, node.to, selections);

  // Background + monospace on EVERY line. HyperMD-codeblock-bg lets the theme
  // paint its dedicated --code-block-background (Things) on the whole box.
  for (let n = open.number; n <= close.number; n++) {
    decos.push(
      Decoration.line({
        class: "ofm-codeblock HyperMD-codeblock HyperMD-codeblock-bg cm-hmd-codeblock",
      }).range(state.doc.line(n).from)
    );
  }

  if (revealed) {
    // Editing: show the ``` fences as source; round the fence lines as edges.
    decos.push(Decoration.line({ class: "ofm-codeblock-begin" }).range(open.from));
    decos.push(Decoration.line({ class: "ofm-codeblock-end" }).range(close.from));
    return;
  }

  // Not editing: collapse the ``` fence lines and present a clean boxed block
  // with a language label, like Obsidian's reading-flavored code block.
  decos.push(Decoration.line({ class: "ofm-codeblock-fence" }).range(open.from));
  if (close.number !== open.number) {
    decos.push(Decoration.line({ class: "ofm-codeblock-fence" }).range(close.from));
  }
  const firstInner = open.number + 1;
  const lastInner = close.number - 1;
  if (lastInner >= firstInner) {
    const firstLine = state.doc.line(firstInner);
    decos.push(Decoration.line({ class: "ofm-codeblock-begin" }).range(firstLine.from));
    decos.push(
      Decoration.line({ class: "ofm-codeblock-end" }).range(state.doc.line(lastInner).from)
    );
    // side:-1 → at the very start of the first code line; CSS positions the
    // flair (optional language label + Copy button) in the block's top-right
    // corner. Added for every block (even without a language) so the Copy
    // button is always available.
    const code = codeFrom >= 0 ? docText.slice(codeFrom, codeTo) : "";
    decos.push(
      Decoration.widget({ widget: new CodeLangWidget(lang, code), side: -1 }).range(firstLine.from)
    );
  } else {
    // Empty block (no code lines): keep the open line as the rounded box.
    decos.push(
      Decoration.line({ class: "ofm-codeblock-begin ofm-codeblock-end" }).range(open.from)
    );
  }
}

// Matches a callout's title line: leading `>`s, then `[!type]` with optional fold sign.
const CALLOUT_RE = /^(\s*>+\s*)(\[!(\w+)\][+-]?)/;

/**
 * Setext heading (`Title` followed by `===` → h1 / `---` → h2): style the text
 * line(s) with the heading classes and hide the underline marker when not being
 * edited. ATX headings go through computeDecorationPlan; setext is rarer and
 * spans two lines, so it gets its own direct path here.
 */
function addSetextHeadingDecorations(
  node: SyntaxNodeRef,
  level: 1 | 2,
  state: EditorState,
  selections: SelectionRange[],
  decos: Range<Decoration>[]
): void {
  let markFrom = -1;
  let markTo = -1;
  const cur = node.node.cursor();
  if (cur.firstChild()) {
    do {
      if (cur.name === MARK_HEADING) {
        markFrom = cur.from;
        markTo = cur.to;
        break;
      }
    } while (cur.nextSibling());
  }

  const firstLine = state.doc.lineAt(node.from);
  const underlineLine =
    markFrom >= 0 ? state.doc.lineAt(markFrom) : state.doc.lineAt(node.to);

  // Heading classes on the text line(s) (everything above the underline).
  for (let n = firstLine.number; n < underlineLine.number; n++) {
    decos.push(
      Decoration.line({
        class: `ofm-heading-${level} HyperMD-header-${level} cm-header-${level}`,
      }).range(state.doc.line(n).from)
    );
  }

  // Hide the `===` / `---` underline when the cursor is not inside the heading.
  // Collapse the whole underline line via a display:none line decoration —
  // a cross-newline replace is illegal for non-block decorations in CM6.
  if (markFrom >= 0 && !shouldRevealConstruct(node.from, node.to, selections)) {
    const ul = state.doc.lineAt(markFrom);
    decos.push(Decoration.line({ class: "ofm-hidden-line" }).range(ul.from));
  }
}

/**
 * Blockquotes. Obsidian callouts (`> [!type] …`) get a colored box and the
 * `[!type]` marker hidden (reveal-gated). Plain blockquotes get a left border +
 * subtle tint (no marker hiding — the `>` stays as source).
 */
function addBlockquoteDecorations(
  node: SyntaxNodeRef,
  state: EditorState,
  selections: SelectionRange[],
  decos: Range<Decoration>[]
): void {
  const firstLine = state.doc.lineAt(node.from);
  const m = CALLOUT_RE.exec(firstLine.text);
  if (!m) {
    // Plain blockquote: left border + the Obsidian quote classes so the active
    // theme styles it (Things → italic + accent color on the quoted content).
    const last = state.doc.lineAt(node.to);
    for (let n = firstLine.number; n <= last.number; n++) {
      const line = state.doc.line(n);
      decos.push(
        Decoration.line({ class: "ofm-blockquote HyperMD-quote cm-quote cm-quote-1" }).range(
          line.from
        )
      );
      // Mark the quoted content (after the leading `>`s) so `span.cm-quote` rules
      // (Things' italic/color) apply to the text itself.
      const prefix = /^(?:\s*>+\s?)+/.exec(line.text);
      const contentStart = line.from + (prefix ? prefix[0].length : 0);
      if (contentStart < line.to) {
        decos.push(
          Decoration.mark({ class: "cm-quote cm-quote-1" }).range(contentStart, line.to)
        );
      }
    }
    // Hide the `>` marks when not editing (Obsidian shows just the quoted text
    // inside the border). Revealed (raw `>`) while the cursor is inside.
    if (!shouldRevealConstruct(node.from, node.to, selections)) {
      const cur = node.node.cursor();
      while (cur.next()) {
        if (cur.from >= node.to) break;
        if (cur.name === "QuoteMark") {
          let end = cur.to;
          if (state.doc.sliceString(end, end + 1) === " ") end += 1;
          decos.push(Decoration.replace({}).range(cur.from, end));
        }
      }
    }
    return;
  }

  const type = m[3].toLowerCase();
  const lastLine = state.doc.lineAt(node.to);

  for (let n = firstLine.number; n <= lastLine.number; n++) {
    const line = state.doc.line(n);
    const cls =
      n === firstLine.number
        ? `ofm-callout ofm-callout-${type} ofm-callout-title`
        : `ofm-callout ofm-callout-${type}`;
    decos.push(Decoration.line({ class: cls }).range(line.from));
  }

  // While the cursor is inside the callout, show raw source (> and [!type]).
  if (shouldRevealConstruct(node.from, node.to, selections)) return;

  // Hide the `[!type]` marker on the title line. If there's NO custom title
  // text after it, show the capitalized type name instead (Obsidian behavior) —
  // otherwise just remove the marker (+ one trailing space) and keep the title.
  const markerFrom = firstLine.from + m[1].length;
  const markerEnd = markerFrom + m[2].length;
  const customTitle = firstLine.text.slice(m[1].length + m[2].length).trim();
  if (customTitle.length === 0) {
    const label = type.charAt(0).toUpperCase() + type.slice(1);
    decos.push(
      Decoration.replace({ widget: new CalloutTitleWidget(label) }).range(markerFrom, markerEnd)
    );
  } else {
    let markerTo = markerEnd;
    if (state.doc.sliceString(markerTo, markerTo + 1) === " ") markerTo += 1;
    decos.push(Decoration.replace({}).range(markerFrom, markerTo));
  }

  // Hide each `>` quote mark (+ one trailing space) within the callout.
  const cur = node.node.cursor();
  while (cur.next()) {
    if (cur.from >= node.to) break;
    if (cur.name === "QuoteMark") {
      let end = cur.to;
      if (state.doc.sliceString(end, end + 1) === " ") end += 1;
      decos.push(Decoration.replace({}).range(cur.from, end));
    }
  }
}

/**
 * Push a Decoration.mark over the content portion of an inline construct,
 * excluding the marker boundaries. For `**bold**`, marks "bold" only.
 */
function addInlineContentDecor(
  decos: Range<Decoration>[],
  node: SyntaxNodeRef,
  className: string
): void {
  const cursor = node.node.cursor();
  if (!cursor.firstChild()) return;

  const children: { from: number; to: number }[] = [];
  do {
    children.push({ from: cursor.from, to: cursor.to });
  } while (cursor.nextSibling());

  if (children.length < 2) return;

  // First child is opening marker, last child is closing marker; content is
  // everything between them.
  const contentFrom = children[0].to;
  const contentTo = children[children.length - 1].from;

  if (contentFrom < contentTo) {
    decos.push(Decoration.mark({ class: className }).range(contentFrom, contentTo));
  }
}

// ---------------------------------------------------------------------------
// ViewPlugin
// ---------------------------------------------------------------------------

/**
 * The editor's visible ranges, each snapped outward to whole lines. CM6 already
 * pads `visibleRanges` with a render margin; snapping to line bounds guarantees
 * a block construct (heading / callout / code fence) that straddles the
 * viewport edge is iterated in full, so its line decorations are not clipped.
 */
function visibleRangesOf(view: EditorView): VisibleRange[] {
  const doc = view.state.doc;
  return view.visibleRanges.map(({ from, to }) => ({
    from: doc.lineAt(from).from,
    to: doc.lineAt(to).to,
  }));
}

const markdownDecorationsPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view.state, visibleRangesOf(view));
    }

    update(update: ViewUpdate) {
      const imageMapChanged = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setImageMap))
      );
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        imageMapChanged
      ) {
        // Viewport-limited: only decorate visible ranges (+CM6's own margin) so
        // per-keystroke cost is O(viewport), not O(document).
        this.decorations = buildDecorations(update.state, visibleRangesOf(update.view));
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

// ---------------------------------------------------------------------------
// Block decorations (mermaid) — MUST come from a StateField, not a ViewPlugin
// (CM6: "Block decorations may not be specified via plugins").
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tolerant GFM-table detection (pure; exported for unit tests).
//
// @lezer/markdown's table parser is stricter than GFM/Obsidian — e.g. a
// delimiter row with a trailing space (`|---|---| `) is rejected, silently
// dropping a real table. We detect tables ourselves: a non-blank row containing
// `|`, immediately followed by a delimiter row of `-`/`:` cells (tolerant of
// surrounding whitespace), plus any following `|` rows. Fenced code is skipped.
// ---------------------------------------------------------------------------

const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

export function isTableDelimiter(line: string): boolean {
  return line.includes("-") && TABLE_DELIMITER_RE.test(line);
}
function looksLikeTableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

export function findTableBlocks(text: string): { from: number; to: number }[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1; // +1 for the consumed "\n" (CRLF: the \r stays in `l`)
  }

  const blocks: { from: number; to: number }[] = [];
  let inFence = false;
  let fenceChar = "";
  let i = 0;
  while (i < lines.length) {
    const fence = FENCE_RE.exec(lines[i]);
    if (fence) {
      const ch = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar) {
        inFence = false;
        fenceChar = "";
      }
      i++;
      continue;
    }
    if (inFence) {
      i++;
      continue;
    }
    if (
      i + 1 < lines.length &&
      looksLikeTableRow(lines[i]) &&
      !isTableDelimiter(lines[i]) &&
      isTableDelimiter(lines[i + 1])
    ) {
      let j = i + 2;
      while (j < lines.length && looksLikeTableRow(lines[j])) j++;
      blocks.push({ from: starts[i], to: starts[j - 1] + lines[j - 1].length });
      i = j;
      continue;
    }
    i++;
  }
  return blocks;
}

/**
 * Obsidian `%%comment%%` ranges (inline and block), skipping fenced code so
 * mermaid's `%%` comments are left alone. `%%` markers are paired in document
 * order (1st–2nd, 3rd–4th, …); each pair's range spans the opening `%%` through
 * the closing `%%`. Used to hide comments in preview (reveal-gated by the view).
 */
export function findComments(text: string): { from: number; to: number }[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }
  const markers: number[] = [];
  let inFence = false;
  let fenceChar = "";
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE_RE.exec(lines[i]);
    if (fence) {
      const ch = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar) {
        inFence = false;
        fenceChar = "";
      }
      continue;
    }
    if (inFence) continue;
    let idx = lines[i].indexOf("%%");
    while (idx !== -1) {
      markers.push(starts[i] + idx);
      idx = lines[i].indexOf("%%", idx + 2);
    }
  }
  const ranges: { from: number; to: number }[] = [];
  for (let k = 0; k + 1 < markers.length; k += 2) {
    ranges.push({ from: markers[k], to: markers[k + 1] + 2 });
  }
  return ranges;
}

const FOOTNOTE_DEF_RE = /^(\s*)\[\^([^\]\s]+)\]:/;
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\]/g;

/**
 * Footnote markers, skipping fenced code. A footnote isn't a standard
 * @lezer/markdown node, so (like tables/comments) we detect it ourselves.
 * `idFrom`/`idTo` bound the label so the view can superscript it and hide the
 * surrounding `[^` … `]` (ref) / `]:` (definition) syntax.
 */
export function findFootnotes(
  text: string
): { from: number; to: number; idFrom: number; idTo: number }[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }
  const out: { from: number; to: number; idFrom: number; idTo: number }[] = [];
  let inFence = false;
  let fenceChar = "";
  for (let i = 0; i < lines.length; i++) {
    const fence = FENCE_RE.exec(lines[i]);
    if (fence) {
      const ch = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
      } else if (ch === fenceChar) {
        inFence = false;
        fenceChar = "";
      }
      continue;
    }
    if (inFence) continue;
    const line = lines[i];
    const def = FOOTNOTE_DEF_RE.exec(line);
    if (def) {
      // `[^id]:` — hide `[^` and `]:`, superscript the id.
      const from = starts[i] + def[1].length;
      const idFrom = from + 2;
      const idTo = idFrom + def[2].length;
      out.push({ from, to: idTo + 2, idFrom, idTo });
      continue; // a definition line isn't also scanned for refs
    }
    FOOTNOTE_REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FOOTNOTE_REF_RE.exec(line)) !== null) {
      const from = starts[i] + m.index;
      const idFrom = from + 2;
      const idTo = idFrom + m[1].length;
      out.push({ from, to: idTo + 1, idFrom, idTo });
    }
  }
  return out;
}

function buildBlockWidgets(state: EditorState): DecorationSet {
  if (state.doc.length > LARGE_FILE_CHARS) return Decoration.none;
  const tree = syntaxTree(state);
  const docText = state.doc.toString();
  const selections: SelectionRange[] = state.selection.ranges.map((r) => ({
    from: r.from,
    to: r.to,
  }));
  const decos: Range<Decoration>[] = [];

  // Frontmatter → Properties panel (Obsidian-style) when not being edited. While
  // the cursor is inside it (reveal) or when the YAML is beyond the parser's
  // simple subset, we fall back to the raw dimmed YAML the ViewPlugin renders.
  const fm = FRONTMATTER_RE.exec(docText);
  if (fm) {
    const fmEnd = fm[0].length;
    const closeLine = state.doc.lineAt(Math.max(0, fmEnd - 1));
    if (!shouldRevealConstruct(0, closeLine.to, selections)) {
      const props = parseFrontmatter(docText.slice(0, fmEnd));
      if (props && props.length > 0) {
        decos.push(
          Decoration.replace({
            widget: new FrontmatterWidget(props),
            block: true,
          }).range(0, closeLine.to)
        );
      }
    }
  }

  // Mermaid (fenced code) via the Lezer tree — fenced code is parsed reliably.
  tree.iterate({
    enter: (node) => {
      if (node.type.name !== "FencedCode") return undefined;
      if (shouldRevealConstruct(node.from, node.to, selections)) return undefined;
      let lang = "";
      let codeFrom = -1;
      let codeTo = -1;
      const cur = node.node.cursor();
      if (cur.firstChild()) {
        do {
          if (cur.name === "CodeInfo") {
            lang = docText.slice(cur.from, cur.to).trim().toLowerCase();
          } else if (cur.name === "CodeText") {
            codeFrom = cur.from;
            codeTo = cur.to;
          }
        } while (cur.nextSibling());
      }
      if (lang === "mermaid" && codeFrom >= 0) {
        const code = docText.slice(codeFrom, codeTo);
        decos.push(
          Decoration.replace({
            widget: new MermaidWidget(code, isMermaidRendered(code)),
            block: true,
          }).range(node.from, node.to)
        );
      }
      return undefined;
    },
  });

  // Tables: detected OURSELVES, tolerantly (GFM/Obsidian accept a delimiter row
  // with surrounding whitespace; @lezer/markdown rejects it, which dropped real
  // tables). Always rendered (editable in place, never reverted to source).
  for (const b of findTableBlocks(docText)) {
    decos.push(
      Decoration.replace({
        widget: new TableWidget(docText.slice(b.from, b.to), b.from),
        block: true,
      }).range(b.from, b.to)
    );
  }

  return Decoration.set(decos, true);
}

const blockWidgetsField = StateField.define<DecorationSet>({
  create: (state) => buildBlockWidgets(state),
  update(value, tr) {
    // Also rebuild when a mermaid diagram finishes rendering, so its widget is
    // re-created and re-measured at the final (post-render) height.
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(mermaidRenderedEffect))
    ) {
      return buildBlockWidgets(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export { markdownDecorationsPlugin, blockWidgetsField };

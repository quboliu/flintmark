// Pure edit-action logic for the formatting shortcuts and smart paste. Kept free
// of CodeMirror/DOM so it unit-tests at L1 — the wrap/unwrap boundary math and
// the link-paste decision are where the bugs hide. The CM6 Command/keymap
// wrappers that call these live in formatCommands.ts.

/** A single replace of [from, to) with `insert`, plus the resulting selection. */
export interface InlineEdit {
  from: number;
  to: number;
  insert: string;
  /** Selection anchor after the edit (absolute doc offset). */
  selFrom: number;
  /** Selection head after the edit (absolute doc offset). */
  selTo: number;
}

/** A single URL with no internal whitespace (the only thing we auto-linkify). */
export const URL_RE = /^(?:https?|mailto):\/?\/?[^\s]+$/i;

/**
 * Smart paste: when the clipboard is a single URL and there is a non-empty
 * selection, turn the selection into a Markdown link `[selection](url)`. Returns
 * the replacement string, or null to fall back to the editor's default paste.
 */
export function linkPasteTransform(selText: string, clip: string): string | null {
  if (!selText) return null;
  const url = clip.trim();
  if (!url || !URL_RE.test(url)) return null;
  // A URL already inside the selection shouldn't be double-wrapped into a link
  // label that is itself a URL pointing elsewhere — but wrapping is still the
  // intuitive result, so we keep it simple and wrap the selected text as-is.
  return `[${selText}](${url})`;
}

/**
 * Toggle a symmetric inline marker (`**`, `*`, `` ` ``, `~~`) around [from, to).
 * Unwraps when the markers are already present (either inside the selection or
 * immediately surrounding it); otherwise wraps. With an empty selection it
 * inserts the pair and places the caret between them.
 */
export function toggleInlineWrap(
  text: string,
  from: number,
  to: number,
  marker: string
): InlineEdit {
  const L = marker.length;
  const c = marker[0];
  // A single-char marker (`*`, `` ` ``) must not treat a char that is part of a
  // longer run (`**` bold, ``` ``` ``` …) as its own delimiter — otherwise
  // Mod-I on the inner text of **bold** would strip a `*` and turn it into
  // *bold* instead of adding italic. So we only unwrap when the adjacent char on
  // the marker side is NOT the marker char.
  const single = L === 1;

  const inner = text.slice(from, to);

  // Unwrap — markers are part of the selection: **bold** selected.
  if (
    to - from >= 2 * L &&
    inner.startsWith(marker) &&
    inner.endsWith(marker) &&
    !(single && (inner[L] === c || inner[inner.length - L - 1] === c))
  ) {
    const stripped = inner.slice(L, inner.length - L);
    return { from, to, insert: stripped, selFrom: from, selTo: from + stripped.length };
  }

  // Unwrap — markers sit just outside the selection: **|bold|**.
  if (
    from - L >= 0 &&
    text.slice(from - L, from) === marker &&
    text.slice(to, to + L) === marker &&
    !(single && (text[from - L - 1] === c || text[to + L] === c))
  ) {
    return {
      from: from - L,
      to: to + L,
      insert: inner,
      selFrom: from - L,
      selTo: from - L + inner.length,
    };
  }

  // Wrap. Empty selection → caret lands between the markers.
  return {
    from,
    to,
    insert: marker + inner + marker,
    selFrom: from + L,
    selTo: from + L + inner.length,
  };
}

/**
 * Wrap [from, to) as a Markdown link. Selected text becomes the label and the
 * caret lands inside the empty `()` ready for the URL; with an empty selection
 * the caret lands inside the `[]` to type the label first.
 */
export function makeLinkEdit(text: string, from: number, to: number): InlineEdit {
  const inner = text.slice(from, to);
  const insert = `[${inner}]()`;
  if (inner.length === 0) {
    // [] () — caret inside the brackets.
    return { from, to, insert, selFrom: from + 1, selTo: from + 1 };
  }
  // [label](|) — caret inside the parens.
  const caret = from + 1 + inner.length + 2; // after "[" + label + "]("
  return { from, to, insert, selFrom: caret, selTo: caret };
}

/**
 * Detect an Obsidian "extended" task marker (`[/]`, `[-]`, `[>]`, `[?]`, …) that
 * the GFM parser does NOT recognize (it only tags `[ ]` / `[x]`). `pos` is the
 * offset right after a list mark. Returns the bracket range + the inner char, or
 * null when there is no single-char marker there. The space/x/X markers are left
 * to the GFM TaskMarker path and reported as null here.
 */
export function detectExtendedTask(
  text: string,
  pos: number
): { from: number; to: number; char: string } | null {
  let i = pos;
  while (text[i] === " " || text[i] === "\t") i++;
  if (text[i] !== "[" || text[i + 2] !== "]") return null;
  const char = text[i + 1];
  if (char === undefined) return null;
  if (char === " " || char === "x" || char === "X") return null; // GFM handles these
  // Must be a task marker (followed by whitespace or end of line), not `[a](url)`.
  const after = text[i + 3];
  if (after !== undefined && after !== " " && after !== "\t" && after !== "\n" && after !== "\r") {
    return null;
  }
  return { from: i, to: i + 3, char };
}

// Minimal YAML-frontmatter parser for the Properties panel. Deliberately NOT a
// full YAML engine (no dependency): it handles the common frontmatter subset —
// `key: scalar`, block lists (`key:` then `  - item`), inline arrays
// (`key: [a, b]`), and empty values. Anything it doesn't confidently understand
// (nested maps, multi-line scalars, …) returns null so the caller falls back to
// rendering the raw (dimmed) YAML instead of mis-rendering it. Pure → L1-testable.

export interface FrontmatterProp {
  key: string;
  /** Values: one entry for a scalar, N for a list, none for an empty value. */
  items: string[];
  /** True when the value is a list (block `- ` or inline `[…]`). */
  list: boolean;
}

/** Icon category for a property, for the Properties panel's leading glyph. */
export type PropIcon = "text" | "list" | "tags" | "date";

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** Locate a leading YAML frontmatter block, including fences and the optional
 *  newline after the closing fence. */
export function findFrontmatterRange(text: string): { from: 0; to: number } | null {
  const m = FRONTMATTER_RE.exec(text);
  return m ? { from: 0, to: m[0].length } : null;
}

/** Infer the display icon for a property: tags/list for sequences, date for an
 *  ISO-ish scalar, else text. Pure → unit-testable. */
export function propIconType(prop: FrontmatterProp): PropIcon {
  if (prop.list) return /^tags?$/i.test(prop.key) ? "tags" : "list";
  return DATE_RE.test(prop.items[0] ?? "") ? "date" : "text";
}

const KEY_RE = /^([A-Za-z0-9_][\w.-]*):[ \t]*(.*)$/;
const LIST_ITEM_RE = /^[ \t]+-[ \t]+(.*)$/;

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return t;
}

/** Split an inline-array body on commas that are OUTSIDE quotes, dropping the
 *  quote chars — so `"Smith, Jane", Janie` → ["Smith, Jane", "Janie"]. */
function splitInlineArray(inner: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = "";
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out.filter((s) => s.length > 0);
}

/**
 * Parse a frontmatter block (including its `---` fences) into ordered properties,
 * or null when the structure is anything beyond the supported subset.
 */
export function parseFrontmatter(fmText: string): FrontmatterProp[] | null {
  const lines = fmText.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return null;

  // Body = between the opening --- and the first closing --- / ... line.
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  const body = lines.slice(1, end);

  const props: FrontmatterProp[] = [];
  for (let i = 0; i < body.length; i++) {
    const line = body[i];
    if (line.trim() === "") continue;
    if (LIST_ITEM_RE.test(line)) continue; // consumed by the key above; stray → ok to skip

    const m = KEY_RE.exec(line);
    if (!m) return null; // unrecognized (indented map, continuation, …) → fall back

    const key = m[1];
    const rest = m[2].trim();

    if (rest === "") {
      // Either a block list on the following lines, or an empty value. Blank
      // lines inside the list are tolerated (skipped); a non-blank, non-item line
      // ends the list.
      const items: string[] = [];
      let j = i + 1;
      let last = i; // last line consumed by this list
      for (; j < body.length; j++) {
        if (body[j].trim() === "") continue; // blank within the list — skip
        const lm = LIST_ITEM_RE.exec(body[j]);
        if (!lm) break;
        items.push(stripQuotes(lm[1]));
        last = j;
      }
      props.push({ key, items, list: items.length > 0 });
      i = last;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      props.push({ key, items: splitInlineArray(rest.slice(1, -1)), list: true });
    } else {
      props.push({ key, items: [stripQuotes(rest)], list: false });
    }
  }

  return props.length > 0 ? props : null;
}

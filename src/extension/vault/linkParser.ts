// Vault Index · pure link/tag extraction (NO vscode, NO DOM — Node-testable).
//
// Parses a Note's Markdown text into the two reference kinds the Vault Index
// cares about (CONTEXT.md → "Vault Index", "Note"):
//   • outgoing wikilink targets:  [[Target]] / [[Target|alias]] /
//     [[Target#Heading]] / [[Target#^block]]  → bare target (alias + #/^ suffix stripped)
//   • tags:  #tag  (same rule as the editor's Lezer Tag node, see
//     src/webview/kernel/obsidianSyntax.ts: not preceded by an alphanumeric,
//     body made of tag-chars and containing at least one letter)
//
// References inside inline code spans (`like this`) and fenced code blocks
// (``` … ```) are ignored, mirroring the parser the Editing Surface uses (where
// the InlineCode / FencedCode nodes are claimed before Tag/WikiLink can fire).
// This keeps the Index's link graph faithful to what the user actually sees.

const BACKTICK = 96; // `
const HASH = 35; //    #
const LBRACKET = 91; // [
const RBRACKET = 93; // ]

function isAlnum(ch: number): boolean {
  return (
    (ch >= 48 && ch <= 57) || // 0-9
    (ch >= 65 && ch <= 90) || // A-Z
    (ch >= 97 && ch <= 122) //   a-z
  );
}
function isAlpha(ch: number): boolean {
  return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122);
}
function isTagChar(ch: number): boolean {
  // alnum + '-' '_' '/'  (matches obsidianSyntax.ts)
  return isAlnum(ch) || ch === 45 || ch === 95 || ch === 47;
}

/** A single `[[…]]` occurrence with its parts split out. */
export interface WikiLinkRef {
  /** Bare note name: alias (`|…`) and subpath (`#…` / `^…`) stripped, trimmed. */
  target: string;
  /** Display alias after `|`, or null. */
  alias: string | null;
  /** Heading / block reference after `#` or `^` (marker stripped), or null. */
  subpath: string | null;
  /** Raw matched source, including the surrounding `[[` `]]`. */
  raw: string;
  /** Inclusive start offset of `[[` in the original text. */
  from: number;
  /** Exclusive end offset just past `]]` in the original text. */
  to: number;
}

/** A single `#tag` occurrence. */
export interface TagRef {
  /** Tag text WITHOUT the leading `#`, e.g. `project/sub`. */
  tag: string;
  /** Inclusive start offset of `#` in the original text. */
  from: number;
  /** Exclusive end offset just past the last tag char. */
  to: number;
}

/** Everything the Index extracts from one Note's text. */
export interface ParsedNote {
  links: WikiLinkRef[];
  tags: TagRef[];
}

// ---------------------------------------------------------------------------
// Inline code spans: mark every char inside a `…` / ``…`` span (delimiters
// included) so we never start a match there. Closing run must be EXACTLY the
// opening length (CommonMark). An unterminated run is literal text.
// ---------------------------------------------------------------------------

function codeMask(line: string): boolean[] {
  const mask = new Array<boolean>(line.length).fill(false);
  let i = 0;
  while (i < line.length) {
    if (line.charCodeAt(i) === BACKTICK) {
      let n = 1;
      while (i + n < line.length && line.charCodeAt(i + n) === BACKTICK) n++;
      const open = i;
      let j = i + n;
      let close = -1;
      while (j < line.length) {
        if (line.charCodeAt(j) === BACKTICK) {
          let m = 1;
          while (j + m < line.length && line.charCodeAt(j + m) === BACKTICK) m++;
          if (m === n) {
            close = j;
            break;
          }
          j += m; // wrong-length run can't close; skip it whole
        } else {
          j++;
        }
      }
      if (close >= 0) {
        for (let k = open; k < close + n; k++) mask[k] = true;
        i = close + n;
        continue;
      }
      i += n; // unterminated: backticks are literal
      continue;
    }
    i++;
  }
  return mask;
}

// ---------------------------------------------------------------------------
// Fenced code blocks: a line opening ``` / ~~~ (>=3) starts a fence; a line of
// the same fence char, length >= the opener and nothing but whitespace after,
// closes it. Everything in between is skipped wholesale.
// ---------------------------------------------------------------------------

function fenceOpen(line: string): { ch: string; len: number } | null {
  const m = /^[ \t]*(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  return { ch: m[1][0], len: m[1].length };
}
function fenceCloses(line: string, ch: string, len: number): boolean {
  const m = new RegExp(`^[ \\t]*(\\${ch}{${len},})[ \\t]*$`).exec(line);
  return m !== null;
}

// ---------------------------------------------------------------------------
// Per-line wikilink + tag scanning.
// ---------------------------------------------------------------------------

function splitWikiLink(
  inner: string
): { target: string; alias: string | null; subpath: string | null } {
  let main = inner;
  let alias: string | null = null;
  const pipe = inner.indexOf("|");
  if (pipe >= 0) {
    alias = inner.slice(pipe + 1).trim();
    main = inner.slice(0, pipe);
  }
  let subpath: string | null = null;
  const sub = main.search(/[#\^]/);
  if (sub >= 0) {
    subpath = main.slice(sub + 1).trim();
    main = main.slice(0, sub);
  }
  return { target: main.trim(), alias, subpath };
}

function scanLine(
  line: string,
  base: number,
  links: WikiLinkRef[],
  tags: TagRef[]
): void {
  const mask = codeMask(line);
  const len = line.length;
  // Local [from,to) ranges of wikilinks, so a `#` inside `[[…]]` isn't a tag.
  const wiki: Array<[number, number]> = [];

  let i = 0;
  while (i < len) {
    if (
      !mask[i] &&
      line.charCodeAt(i) === LBRACKET &&
      i + 1 < len &&
      line.charCodeAt(i + 1) === LBRACKET
    ) {
      let k = i + 2;
      let close = -1;
      while (k + 1 < len) {
        if (
          line.charCodeAt(k) === RBRACKET &&
          line.charCodeAt(k + 1) === RBRACKET
        ) {
          close = k;
          break;
        }
        k++;
      }
      if (close > i + 2) {
        const inner = line.slice(i + 2, close);
        const parts = splitWikiLink(inner);
        links.push({
          ...parts,
          raw: line.slice(i, close + 2),
          from: base + i,
          to: base + close + 2,
        });
        wiki.push([i, close + 2]);
        i = close + 2;
        continue;
      }
    }
    i++;
  }

  const inWiki = (idx: number): boolean =>
    wiki.some(([a, b]) => idx >= a && idx < b);

  i = 0;
  while (i < len) {
    if (line.charCodeAt(i) === HASH && !mask[i] && !inWiki(i)) {
      const prev = i > 0 ? line.charCodeAt(i - 1) : -1;
      if (prev !== -1 && isAlnum(prev)) {
        i++;
        continue;
      }
      let j = i + 1;
      let hasAlpha = false;
      while (j < len && isTagChar(line.charCodeAt(j))) {
        if (isAlpha(line.charCodeAt(j))) hasAlpha = true;
        j++;
      }
      if (j > i + 1 && hasAlpha) {
        tags.push({ tag: line.slice(i + 1, j), from: base + i, to: base + j });
        i = j;
        continue;
      }
    }
    i++;
  }
}

/** Parse a Note's full text into its outgoing wikilinks and tags. */
export function parseNote(text: string): ParsedNote {
  const links: WikiLinkRef[] = [];
  const tags: TagRef[] = [];

  let fence: { ch: string; len: number } | null = null;
  // Walk line by line, preserving exact offsets (links/tags are single-line:
  // the editor's parsers bail at a newline, so we never cross one).
  const re = /\r?\n/g;
  let lineStart = 0;
  let m: RegExpExecArray | null;
  const pushLine = (line: string, start: number): void => {
    if (fence) {
      if (fenceCloses(line, fence.ch, fence.len)) fence = null;
      return;
    }
    const open = fenceOpen(line);
    if (open) {
      fence = open;
      return;
    }
    scanLine(line, start, links, tags);
  };
  while ((m = re.exec(text)) !== null) {
    pushLine(text.slice(lineStart, m.index), lineStart);
    lineStart = m.index + m[0].length;
  }
  pushLine(text.slice(lineStart), lineStart);

  return { links, tags };
}

/** Convenience: just the outgoing wikilinks. */
export function extractWikiLinks(text: string): WikiLinkRef[] {
  return parseNote(text).links;
}

/** Convenience: just the tags. */
export function extractTags(text: string): TagRef[] {
  return parseNote(text).tags;
}

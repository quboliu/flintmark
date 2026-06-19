// Pure heading-outline parsing (NO vscode import) so it is unit-testable in
// Node. outline.ts maps the result onto vscode.DocumentSymbols.

export interface HeadingInfo {
  level: number; // 1..6
  text: string;
  line: number; // 0-based line of the heading
}

const ATX_RE = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const SETEXT_H1_RE = /^=+\s*$/;
const SETEXT_H2_RE = /^-+\s*$/;
const FRONTMATTER_DELIM_RE = /^---\s*$/;

/** True if a line can't be the *text* of a setext heading (would be ambiguous
 *  with a list item, blockquote, ATX heading, fence, or blank). */
function ineligibleSetextText(line: string): boolean {
  return (
    line.trim() === "" ||
    /^\s*(#{1,6})\s/.test(line) ||
    /^\s*(>|[-*+]\s|\d+[.)]\s)/.test(line) ||
    FENCE_RE.test(line)
  );
}

/**
 * Extract ATX (`# …`) and setext (`Title` over `===`/`---`) headings, skipping
 * fenced code blocks and a leading YAML frontmatter block (so `#`/`---` inside
 * them are not mistaken for headings / rules).
 */
export function parseHeadings(text: string): HeadingInfo[] {
  const lines = text.split(/\r?\n/);
  const heads: HeadingInfo[] = [];

  let i = 0;
  // Skip a leading frontmatter block: --- … --- (or … …) at the very top.
  if (lines.length > 0 && FRONTMATTER_DELIM_RE.test(lines[0])) {
    for (let j = 1; j < lines.length; j++) {
      if (FRONTMATTER_DELIM_RE.test(lines[j]) || /^\.\.\.\s*$/.test(lines[j])) {
        i = j + 1;
        break;
      }
    }
  }

  let inFence = false;
  let fenceChar = "";
  for (; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
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

    const atx = ATX_RE.exec(line);
    if (atx) {
      heads.push({ level: atx[1].length, text: atx[2].trim() || "(untitled)", line: i });
      continue;
    }

    // Setext: a paragraph line directly followed by an underline of = or -.
    const next = i + 1 < lines.length ? lines[i + 1] : undefined;
    if (next !== undefined && !ineligibleSetextText(line)) {
      if (SETEXT_H1_RE.test(next)) {
        heads.push({ level: 1, text: line.trim(), line: i });
        i++; // consume the underline
      } else if (SETEXT_H2_RE.test(next)) {
        heads.push({ level: 2, text: line.trim(), line: i });
        i++;
      }
    }
  }

  return heads;
}

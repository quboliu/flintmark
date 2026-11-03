// Pure helpers for converting between document offsets and line/character positions.
// No VS Code or DOM dependencies — works on any text string.

/**
 * Convert a 0-based document offset to {line, character}.
 * Lines are 0-based; character is the UTF-16 code-unit offset within the line.
 */
export function offsetToPosition(
  text: string,
  offset: number
): { line: number; character: number } {
  let line = 0;
  let character = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      character = 0;
    } else {
      character++;
    }
  }
  return { line, character };
}

/**
 * Convert a {line, character} (both 0-based) to a document offset.
 * Clamps to the end of the text if the position is beyond the document.
 */
export function positionToOffset(
  text: string,
  line: number,
  character: number
): number {
  let offset = 0;
  let currentLine = 0;
  let currentChar = 0;
  for (let i = 0; i < text.length; i++) {
    if (currentLine === line && currentChar === character) {
      return offset;
    }
    if (text[i] === "\n") {
      currentLine++;
      currentChar = 0;
    } else {
      currentChar++;
    }
    offset++;
  }
  return offset;
}

/**
 * Normalize a possibly-reversed or out-of-bounds offset pair into a valid,
 * ordered `[from, to]` range clamped to `[0, len]`.
 *
 * This mirrors EXACTLY the clamping the AI Selection Bridge applies before it
 * turns raw webview selection offsets into a source `Selection`
 * (see customTextEditorProvider.handleAiEditSelection). Extracted here so the
 * boundary logic — the part most likely to break on weird offsets — is pure
 * and unit-testable without VS Code.
 *
 * Guarantees for finite inputs: `0 <= from <= to <= len`.
 */
export function clampOffsetRange(
  from: number,
  to: number,
  len: number
): { from: number; to: number } {
  const lo = Math.max(0, Math.min(from, to, len));
  const hi = Math.min(Math.max(0, Math.max(from, to)), len);
  return { from: lo, to: hi };
}

/**
 * Compute the line count of a text string.
 */
export function lineCount(text: string): number {
  if (text.length === 0) return 1;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}

/**
 * Convert CodeMirror offsets (a CRLF counts as 1 character) to the offsets of
 * the same places in the host's `text` (a CRLF counts as 2). Clamps to
 * `[0, text.length]` like `TextDocument.positionAt`.
 */
export function cmToHostOffsets(text: string, offsets: number[]): number[] {
  const crlfs: number[] = [];
  for (let at = text.indexOf("\r\n"); at !== -1; at = text.indexOf("\r\n", at + 2)) {
    crlfs.push(at);
  }
  return offsets.map((offset) => {
    // Binary search for the number of CRLFs that start before `offset`.
    let lo = 0;
    let hi = crlfs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (crlfs[mid] - mid < offset) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, Math.min(offset + lo, text.length));
  });
}

export function cmToHostOffset(text: string, offset: number): number {
  return cmToHostOffsets(text, [offset])[0];
}

/**
 * Convert a host offset on 0-based `line` to the CodeMirror offset. In a CRLF
 * document every earlier line break is one extra character, so exactly `line`
 * characters are subtracted. Needs no text, so it also works for a position in
 * a document that has since changed (see `toDocChanges`).
 */
export function hostToCmOffset(offset: number, line: number): number {
  return offset - line;
}

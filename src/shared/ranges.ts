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

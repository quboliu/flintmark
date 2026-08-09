const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

export function isTableDelimiter(line: string): boolean {
  return line.includes("-") && TABLE_DELIMITER_RE.test(line);
}

function looksLikeTableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

/** Tolerant GFM/Obsidian table detection, independent of the Lezer parser. */
export function findTableBlocks(text: string): { from: number; to: number }[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  let off = 0;
  for (const line of lines) {
    starts.push(off);
    off += line.length + 1;
  }

  const blocks: { from: number; to: number }[] = [];
  let inFence = false;
  let fenceChar = "";
  let i = 0;
  while (i < lines.length) {
    const fence = FENCE_RE.exec(lines[i]);
    if (fence) {
      const char = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceChar = char;
      } else if (char === fenceChar) {
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
      let endLine = i + 2;
      while (endLine < lines.length && looksLikeTableRow(lines[endLine])) endLine++;
      blocks.push({
        from: starts[i],
        to: starts[endLine - 1] + lines[endLine - 1].length,
      });
      i = endLine;
      continue;
    }
    i++;
  }
  return blocks;
}

import { markdownLanguage } from "@codemirror/lang-markdown";

export interface HeadingInfo {
  level: number;
  text: string;
  line: number;
}

export interface TodoInfo {
  /** The single character inside the task marker (`[ ]`, `[x]`, `[/]`, …). */
  status: string;
  /** The task's first-line text, without the list marker or checkbox. */
  text: string;
  /** Zero-based source position of the opening `[` in the task marker. */
  line: number;
  character: number;
  /** Absolute source offsets of the three-character task marker. */
  markerFrom: number;
  markerTo: number;
}

export interface DocumentStructure {
  headings: HeadingInfo[];
  todos: TodoInfo[];
}

const ATX_HEADING_RE = /^ATXHeading([1-6])$/;
const SETEXT_LEVEL: Readonly<Record<string, number>> = {
  SetextHeading1: 1,
  SetextHeading2: 2,
};
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineIndexAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid;
  }
  return low;
}

function lineEndAt(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  const end = newline === -1 ? text.length : newline;
  return end > from && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
}

function headingText(name: string, source: string): string {
  if (name.startsWith("ATXHeading")) {
    const match = /^\s*#{1,6}[ \t]+(.*?)(?:[ \t]+#+[ \t]*)?$/.exec(source);
    return match?.[1].trim() || "(untitled)";
  }
  const firstLineEnd = source.search(/\r?\n/);
  return (firstLineEnd === -1 ? source : source.slice(0, firstLineEnd)).trim();
}

/**
 * A task marker must immediately follow a real Markdown list marker, allowing
 * only horizontal whitespace between them. Lezer identifies ListMark nodes,
 * so code fences, indented code, links, and ordinary bracket text never enter
 * this path. The single-character rule also matches Flintmark's extended task
 * states (`[/]`, `[-]`, `[>]`, `[?]`, …).
 */
function todoAfterListMark(
  text: string,
  listMarkTo: number,
  starts: readonly number[]
): TodoInfo | null {
  const line = lineIndexAt(starts, listMarkTo);
  const end = lineEndAt(text, listMarkTo);
  let markerFrom = listMarkTo;
  while (
    markerFrom < end &&
    (text.charCodeAt(markerFrom) === 32 || text.charCodeAt(markerFrom) === 9)
  ) {
    markerFrom++;
  }

  if (
    markerFrom + 3 > end ||
    text[markerFrom] !== "[" ||
    text[markerFrom + 2] !== "]"
  ) {
    return null;
  }

  const status = text[markerFrom + 1];
  if (status === undefined || status === "]" || status === "\r" || status === "\n") {
    return null;
  }

  const markerTo = markerFrom + 3;
  const after = text[markerTo];
  if (markerTo < end && after !== " " && after !== "\t") return null;

  let textFrom = markerTo;
  while (
    textFrom < end &&
    (text.charCodeAt(textFrom) === 32 || text.charCodeAt(textFrom) === 9)
  ) {
    textFrom++;
  }

  return {
    status,
    text: text.slice(textFrom, end).trimEnd(),
    line,
    character: markerFrom - starts[line],
    markerFrom,
    markerTo,
  };
}

/**
 * Parse headings and task-list items from one GFM syntax tree. This is the
 * shared structural scan used by Outline, Todo, and the native symbol provider.
 */
export function parseDocumentStructure(text: string): DocumentStructure {
  const headings: HeadingInfo[] = [];
  const todos: TodoInfo[] = [];
  const starts = lineStartsOf(text);
  const frontmatterEnd = FRONTMATTER_RE.exec(text)?.[0].length ?? 0;
  const tree = markdownLanguage.parser.parse(text);

  tree.iterate({
    enter(node) {
      if (node.from < frontmatterEnd) return;

      const atx = ATX_HEADING_RE.exec(node.type.name);
      const setext = SETEXT_LEVEL[node.type.name];
      if (atx || setext) {
        const level = atx ? Number(atx[1]) : setext;
        // Preserve Flintmark's existing rule: bare `#` is ordinary text, while
        // `# ` is an untitled heading. Lezer accepts both and excludes the
        // trailing space from the heading node, so inspect the source boundary.
        if (
          atx &&
          node.to === node.from + level &&
          text[node.to] !== " " &&
          text[node.to] !== "\t"
        ) {
          return;
        }
        const source = text.slice(node.from, node.to);
        headings.push({
          level,
          text: headingText(node.type.name, source),
          line: lineIndexAt(starts, node.from),
        });
        return;
      }

      if (node.type.name === "ListMark") {
        const todo = todoAfterListMark(text, node.to, starts);
        if (todo) todos.push(todo);
      }
    },
  });

  return { headings, todos };
}

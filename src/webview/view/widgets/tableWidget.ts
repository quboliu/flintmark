// Renders a GFM table as an EDITABLE HTML <table>. Block widget (multi-line) →
// provided via a StateField. The table is always rendered (never reverted to
// source); cells are contenteditable — focusing shows the cell's raw markdown,
// and blur/Enter/Tab rebuilds the whole table source and dispatches it. Cell
// content renders inline markdown (bold/italic/strike/code/==/links).
import { EditorView, WidgetType } from "@codemirror/view";

// ---------------------------------------------------------------------------
// Minimal, SAFE inline-markdown renderer for table cells (DOM nodes, never
// innerHTML). Handles the common inline constructs; unknown text stays literal.
// ---------------------------------------------------------------------------

const INLINE_RE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(==[^=]+==)|(\*[^*]+\*)|(_[^_]+_)|(!?\[\[[^\]]+\]\])|(\[[^\]]+\]\([^)]+\))/;

function renderInline(text: string, parent: Node): void {
  let rest = text;
  // Guard against pathological inputs.
  for (let guard = 0; guard < 500 && rest.length > 0; guard++) {
    const m = INLINE_RE.exec(rest);
    if (!m) break;
    const idx = m.index;
    if (idx > 0) parent.appendChild(document.createTextNode(rest.slice(0, idx)));
    const tok = m[0];
    appendToken(tok, parent);
    rest = rest.slice(idx + tok.length);
  }
  if (rest.length > 0) parent.appendChild(document.createTextNode(rest));
}

function styled(tag: string, cls: string, inner: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = cls;
  renderInline(inner, el); // allow one level of nesting
  return el;
}

function appendToken(tok: string, parent: Node): void {
  // Emit the SAME classes the body flow uses (ofm-* AND cm-*). Themes (e.g.
  // Things) color inline marks via `span.cm-strong`/`.cm-em`/`.cm-highlight`,
  // so table cells must carry those classes — and be <span>s, not bare
  // <strong>/<em>/<code> — to render identically to body text.
  if (tok.startsWith("`") && tok.endsWith("`")) {
    const code = document.createElement("code");
    code.className = "ofm-inline-code cm-inline-code";
    code.textContent = tok.slice(1, -1);
    parent.appendChild(code);
  } else if (tok.startsWith("**")) {
    parent.appendChild(styled("span", "ofm-strong cm-strong", tok.slice(2, -2)));
  } else if (tok.startsWith("~~")) {
    parent.appendChild(styled("span", "ofm-strikethrough cm-strikethrough", tok.slice(2, -2)));
  } else if (tok.startsWith("==")) {
    parent.appendChild(styled("span", "ofm-highlight cm-highlight", tok.slice(2, -2)));
  } else if (tok.startsWith("*")) {
    parent.appendChild(styled("span", "ofm-emphasis cm-em", tok.slice(1, -1)));
  } else if (tok.startsWith("_")) {
    parent.appendChild(styled("span", "ofm-emphasis cm-em", tok.slice(1, -1)));
  } else if (tok.startsWith("[[") || tok.startsWith("![[")) {
    const inner = tok.replace(/^!?\[\[/, "").replace(/\]\]$/, "");
    const target = inner.split("|")[0].split("#")[0].trim();
    const label = (inner.includes("|") ? inner.split("|").slice(1).join("|") : inner).trim();
    const a = document.createElement("span");
    a.className = "ofm-internal-link";
    a.setAttribute("data-ofm-link", target);
    a.textContent = label;
    parent.appendChild(a);
  } else if (tok.startsWith("[")) {
    const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
    if (m) {
      const a = document.createElement("span");
      a.className = "ofm-external-link";
      a.setAttribute("data-ofm-link", m[2].trim());
      a.textContent = m[1];
      parent.appendChild(a);
    } else {
      parent.appendChild(document.createTextNode(tok));
    }
  } else {
    parent.appendChild(document.createTextNode(tok));
  }
}

export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly from: number
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source && other.from === this.from;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ofm-table-wrap";
    try {
      wrap.appendChild(buildTable(this.source, this.from, view));
    } catch {
      wrap.textContent = this.source;
    }
    return wrap;
  }

  // CM6 ignores events inside the widget; our own per-row mousedown handlers do
  // the cursor positioning (so CM6's broken coordinate mapping never runs).
  ignoreEvent(): boolean {
    return true;
  }
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += s[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

function parseAlign(cell: string): string {
  const c = cell.trim();
  const left = c.startsWith(":");
  const right = c.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}

function alignToken(a: string): string {
  if (a === "center") return ":---:";
  if (a === "right") return "---:";
  if (a === "left") return ":---";
  return "---";
}

function escCell(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/**
 * Build an EDITABLE GFM table. Cells are contenteditable: focusing a cell shows
 * its raw markdown source; editing + blur/Enter/Tab rebuilds the whole table
 * source and dispatches it (the doc is the source of truth). Because we only
 * commit on blur, no per-keystroke doc churn destroys the cell mid-typing, and
 * the widget's eq() (same source) makes CM6 reuse this DOM on selection changes.
 */
function buildTable(source: string, from: number, view: EditorView): HTMLTableElement {
  const raw = source.split("\n");
  const idxs = raw
    .map((l, i) => [l, i] as const)
    .filter(([l]) => l.trim().length > 0)
    .map(([, i]) => i);

  const table = document.createElement("table");
  table.className = "ofm-table";
  if (idxs.length === 0) return table;

  const headers = splitRow(raw[idxs[0]]);
  const aligns = idxs.length > 1 ? splitRow(raw[idxs[1]]).map(parseAlign) : [];

  // Rebuild the whole table markdown from the current cell DOM and dispatch it.
  const commit = (): void => {
    const ths = Array.from(table.querySelectorAll("thead th")) as HTMLElement[];
    const headerCells = ths.map((c) => escCell(c.dataset.raw ?? c.textContent ?? ""));
    const cols = headerCells.length;
    const rows = (Array.from(table.querySelectorAll("tbody tr")) as HTMLElement[]).map((tr) =>
      (Array.from(tr.querySelectorAll("td")) as HTMLElement[]).map((c) =>
        escCell(c.dataset.raw ?? c.textContent ?? "")
      )
    );
    const sep: string[] = [];
    for (let i = 0; i < cols; i++) sep.push(alignToken(aligns[i] ?? ""));
    const lines = [
      "| " + headerCells.join(" | ") + " |",
      "| " + sep.join(" | ") + " |",
      ...rows.map((r) => "| " + r.join(" | ") + " |"),
    ];
    const md = lines.join("\n");
    if (md === source) return; // no change → don't churn the doc
    view.dispatch({
      changes: { from, to: from + source.length, insert: md },
    });
  };

  const makeCell = (tag: "th" | "td", rawText: string, align: string): HTMLElement => {
    const cell = document.createElement(tag);
    cell.dataset.raw = rawText;
    cell.setAttribute("contenteditable", "true");
    cell.spellcheck = false;
    if (align) cell.style.textAlign = align;
    renderInline(rawText, cell); // rendered display

    cell.addEventListener("focus", () => {
      // Show the raw markdown source for editing (only swap if it differs, to
      // avoid moving the caret in plain-text cells).
      const r = cell.dataset.raw ?? "";
      if (cell.textContent !== r) cell.textContent = r;
    });
    cell.addEventListener("blur", () => {
      const edited = (cell.textContent ?? "").replace(/\r?\n/g, " ");
      cell.dataset.raw = edited;
      cell.replaceChildren();
      renderInline(edited, cell); // back to rendered
      commit();
    });
    cell.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        cell.blur();
      } else if (e.key === "Escape") {
        cell.textContent = cell.dataset.raw ?? "";
        cell.blur();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        // Select WITHIN the cell — don't let CM6 select the whole document
        // (which would let the next keystroke replace the entire doc).
        e.preventDefault();
        e.stopPropagation();
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          const r = document.createRange();
          r.selectNodeContents(cell);
          sel.addRange(r);
        }
      }
    });
    return cell;
  };

  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  headers.forEach((h, i) => htr.appendChild(makeCell("th", h, aligns[i] ?? "")));
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (let d = 2; d < idxs.length; d++) {
    const cells = splitRow(raw[idxs[d]]);
    const tr = document.createElement("tr");
    cells.forEach((cell, i) => tr.appendChild(makeCell("td", cell, aligns[i] ?? "")));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

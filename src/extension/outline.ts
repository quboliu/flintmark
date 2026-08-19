import * as vscode from "vscode";
import { DocumentStructureService } from "./documentStructureService";

// ---------------------------------------------------------------------------
// Heading outline. The parsing is pure (outlineParser, no vscode) so it is
// unit-testable in Node (test/kernel); the provider only maps the result onto
// DocumentSymbols. Powers the native Outline view, breadcrumbs, and Go to
// Symbol (Ctrl+Shift+O).
// ---------------------------------------------------------------------------

class OfmDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private readonly structures: DocumentStructureService) {}

  provideDocumentSymbols(
    document: vscode.TextDocument
  ): vscode.DocumentSymbol[] {
    const heads = this.structures.getSnapshot(document).headings;
    const roots: vscode.DocumentSymbol[] = [];
    // Stack of (level, symbol) for nesting; a heading's range extends until the
    // next heading of equal-or-higher level (or end of document).
    const stack: { level: number; sym: vscode.DocumentSymbol }[] = [];

    const lineCount = document.lineCount;

    for (let k = 0; k < heads.length; k++) {
      const h = heads[k];
      if (h.line < 0 || h.line >= lineCount) continue;
      const startLine = document.lineAt(h.line);
      // End line: line before the next heading of level <= this one.
      let endLineNo = lineCount - 1;
      for (let n = k + 1; n < heads.length; n++) {
        if (heads[n].level <= h.level) {
          endLineNo = Math.max(h.line, heads[n].line - 1);
          break;
        }
      }
      endLineNo = Math.min(endLineNo, lineCount - 1);
      if (endLineNo < 0) continue;
      const range = new vscode.Range(
        startLine.range.start,
        document.lineAt(endLineNo).range.end
      );
      const sym = new vscode.DocumentSymbol(
        h.text,
        "",
        vscode.SymbolKind.String,
        range,
        startLine.range
      );

      while (stack.length && stack[stack.length - 1].level >= h.level) {
        stack.pop();
      }
      if (stack.length) stack[stack.length - 1].sym.children.push(sym);
      else roots.push(sym);
      stack.push({ level: h.level, sym });
    }

    return roots;
  }
}

/** Register the heading outline provider for Markdown documents. */
export function registerOutline(
  context: vscode.ExtensionContext,
  structures: DocumentStructureService
): void {
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      [
        { language: "markdown" },
        { scheme: "file", pattern: "**/*.{md,markdown}" },
      ],
      new OfmDocumentSymbolProvider(structures)
    )
  );
}

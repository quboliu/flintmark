import * as vscode from "vscode";
import { parseHeadings } from "./outlineParser";

// ---------------------------------------------------------------------------
// Heading outline. The parsing is pure (outlineParser, no vscode) so it is
// unit-testable in Node (test/kernel); the provider only maps the result onto
// DocumentSymbols. Powers the native Outline view, breadcrumbs, and Go to
// Symbol (Ctrl+Shift+O).
// ---------------------------------------------------------------------------

class OfmDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(
    document: vscode.TextDocument
  ): vscode.DocumentSymbol[] {
    const heads = parseHeadings(document.getText());
    const roots: vscode.DocumentSymbol[] = [];
    // Stack of (level, symbol) for nesting; a heading's range extends until the
    // next heading of equal-or-higher level (or end of document).
    const stack: { level: number; sym: vscode.DocumentSymbol }[] = [];

    for (let k = 0; k < heads.length; k++) {
      const h = heads[k];
      const startLine = document.lineAt(h.line);
      // End line: line before the next heading of level <= this one.
      let endLineNo = document.lineCount - 1;
      for (let n = k + 1; n < heads.length; n++) {
        if (heads[n].level <= h.level) {
          endLineNo = Math.max(h.line, heads[n].line - 1);
          break;
        }
      }
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
export function registerOutline(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(
      [
        { language: "markdown" },
        { scheme: "file", pattern: "**/*.{md,markdown}" },
      ],
      new OfmDocumentSymbolProvider()
    )
  );
}

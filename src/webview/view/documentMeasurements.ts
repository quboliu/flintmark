import { StateField, type EditorState, type Transaction } from "@codemirror/state";
import { FULL_DOCUMENT_LIVE_PREVIEW_CHAR_LIMIT } from "./layoutPreflight";
import { findTableBlocks } from "./tableBlocks";

export interface DocumentMeasurementScan {
  readonly docText: string | undefined;
  readonly tableBlocks: readonly { from: number; to: number }[];
  readonly tableSources: readonly string[];
  readonly svgSources: readonly string[];
}

export interface DocumentMeasurementScanners {
  findTables: (text: string) => readonly { from: number; to: number }[];
  findSvgSources: (text: string) => readonly string[];
}

const defaultScanners: DocumentMeasurementScanners = {
  findTables: findTableBlocks,
  findSvgSources: (text) => [
    ...text.matchAll(/<svg\b[\s\S]*?<\/svg\s*>/gi),
  ].map((match) => match[0]),
};

const sourceFallbackScan: DocumentMeasurementScan = {
  docText: undefined,
  tableBlocks: [],
  tableSources: [],
  svgSources: [],
};

export function createDocumentMeasurementsField(
  scanners: DocumentMeasurementScanners = defaultScanners
): StateField<DocumentMeasurementScan> {
  return StateField.define<DocumentMeasurementScan>({
    create: (state) => scanDocument(state.doc.length, () => state.doc.toString(), scanners),
    update(previous, transaction) {
      if (!transaction.docChanged) return previous;
      if (transaction.newDoc.length > FULL_DOCUMENT_LIVE_PREVIEW_CHAR_LIMIT) {
        return sourceFallbackScan;
      }
      const text = transaction.newDoc.toString();
      if (!needsResourceRescan(previous, transaction)) {
        return { ...previous, docText: text };
      }
      return scanDocument(transaction.newDoc.length, () => text, scanners);
    },
  });
}

export const documentMeasurementsField = createDocumentMeasurementsField();

export function documentMeasurementScan(
  state: EditorState,
  field: StateField<DocumentMeasurementScan> = documentMeasurementsField
): DocumentMeasurementScan {
  return state.field(field, false) ?? scanDocument(
    state.doc.length,
    () => state.doc.toString(),
    defaultScanners
  );
}

function scanDocument(
  length: number,
  materialize: () => string,
  scanners: DocumentMeasurementScanners
): DocumentMeasurementScan {
  if (length > FULL_DOCUMENT_LIVE_PREVIEW_CHAR_LIMIT) return sourceFallbackScan;
  const docText = materialize();
  const tableBlocks = [...scanners.findTables(docText)];
  return {
    docText,
    tableBlocks,
    tableSources: [
      ...new Set(tableBlocks.map((block) => docText.slice(block.from, block.to))),
    ],
    svgSources: [...scanners.findSvgSources(docText)],
  };
}

function needsResourceRescan(
  previous: DocumentMeasurementScan,
  transaction: Transaction
): boolean {
  if (previous.docText === undefined) return true;
  if (previous.tableSources.length > 0 || previous.svgSources.length > 0) return true;

  let relevant = false;
  transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (relevant) return;
    const oldContext = touchedLines(transaction.startState.doc, fromA, toA);
    const newContext = touchedLines(transaction.newDoc, fromB, toB);
    relevant = /[|<]/.test(oldContext) || /[|<]/.test(newContext);
  });
  return relevant;
}

function touchedLines(
  doc: { length: number; lineAt: (position: number) => { from: number; to: number }; sliceString: (from: number, to: number) => string },
  from: number,
  to: number
): string {
  const safeFrom = Math.max(0, Math.min(from, doc.length));
  const safeTo = Math.max(safeFrom, Math.min(to, doc.length));
  const first = doc.lineAt(safeFrom);
  const last = doc.lineAt(safeTo);
  return doc.sliceString(first.from, last.to);
}

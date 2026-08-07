import * as vscode from "vscode";
import type { DocumentStructureSnapshot } from "./documentStructureCache";
import {
  resolveHeadingTarget,
  resolveTodoTarget,
} from "./documentStructureTargets";
import {
  DocumentStructureStore,
  type StructureDocumentInput,
} from "./documentStructureStore";

/** The active Markdown URI for either a Live Preview custom editor or source. */
export function activeMarkdownUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  let uri: vscode.Uri | undefined;
  if (input instanceof vscode.TabInputCustom) uri = input.uri;
  else if (input instanceof vscode.TabInputText) uri = input.uri;
  else uri = vscode.window.activeTextEditor?.document.uri;
  if (!uri) return undefined;
  return /\.(md|markdown)$/i.test(uri.path) ? uri : undefined;
}

function loadedDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === key);
}

function structureInput(document: vscode.TextDocument): StructureDocumentInput {
  return {
    uri: document.uri.toString(),
    version: document.version,
    text: document.getText(),
  };
}

/**
 * Owns the active document's structural snapshot. Text changes are coalesced
 * into a bounded refresh window, while version caching guarantees that tab and
 * editor events cannot trigger duplicate scans of the same document version.
 */
export class DocumentStructureService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | undefined>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly store: DocumentStructureStore;

  readonly onDidChange = this.emitter.event;

  constructor() {
    this.store = new DocumentStructureStore({
      initialActiveUri: activeMarkdownUri()?.toString(),
      onDidChange: (uri) => this.emitter.fire(uri ? vscode.Uri.parse(uri) : undefined),
    });
    this.subscriptions.push(
      vscode.window.tabGroups.onDidChangeTabs(() => this.syncActiveDocument()),
      vscode.window.onDidChangeActiveTextEditor(() => this.syncActiveDocument()),
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (document.uri.toString() === activeMarkdownUri()?.toString()) {
          this.store.setActive(document.uri.toString(), structureInput(document));
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event)),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.store.close(document.uri.toString());
      })
    );
  }

  getActiveSnapshot(): DocumentStructureSnapshot | undefined {
    const uri = activeMarkdownUri();
    if (!uri) return undefined;
    const document = loadedDocument(uri);
    return document ? this.getSnapshot(document) : undefined;
  }

  getSnapshot(document: vscode.TextDocument): DocumentStructureSnapshot {
    return this.store.get(structureInput(document));
  }

  /** Force a user-requested refresh, still producing only one new scan. */
  refreshActive(): void {
    const uri = activeMarkdownUri();
    const document = uri ? loadedDocument(uri) : undefined;
    this.store.refreshActive(
      uri?.toString(),
      document ? structureInput(document) : undefined
    );
  }

  /** Resolve a possibly stale Todo tree item against the latest document. */
  resolveTodo(
    uri: vscode.Uri,
    item: {
      version: number;
      status: string;
      text: string;
      line: number;
      character: number;
      markerFrom: number;
    }
  ): { line: number; character: number } | undefined {
    const document = loadedDocument(uri);
    if (!document) return { line: item.line, character: item.character };
    const snapshot = this.getSnapshot(document);
    return resolveTodoTarget(snapshot, item);
  }

  /** Resolve a possibly stale Outline item against the latest document. */
  resolveHeading(
    uri: vscode.Uri,
    item: { version: number; level: number; text: string; line: number }
  ): { line: number; character: number } | undefined {
    const document = loadedDocument(uri);
    if (!document) return { line: item.line, character: 0 };
    const snapshot = this.getSnapshot(document);
    return resolveHeadingTarget(snapshot, item);
  }

  private syncActiveDocument(): void {
    const uri = activeMarkdownUri();
    const nextKey = uri?.toString();
    const document = uri ? loadedDocument(uri) : undefined;
    this.store.setActive(
      nextKey,
      document ? structureInput(document) : undefined
    );
  }

  private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    const uri = event.document.uri;
    if (uri.toString() !== activeMarkdownUri()?.toString()) return;

    this.store.scheduleDocumentChange(uri.toString(), () => {
      if (uri.toString() !== activeMarkdownUri()?.toString()) return undefined;
      // TextDocument objects are live; read version/text only when the
      // coalesced refresh runs so the newest edit in the burst wins.
      return structureInput(event.document);
    });
  }

  dispose(): void {
    this.store.dispose();
    this.emitter.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

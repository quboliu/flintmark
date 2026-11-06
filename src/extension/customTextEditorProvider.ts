import { ChangeSet } from "@codemirror/state";
import type { Update } from "@codemirror/collab";
import {
  CollaborationAuthority,
  decodeUpdates,
  encodeUpdates,
  extendsPendingUpdates,
} from "../shared/collaboration";
import { noteLinkTarget, noteLinkCandidates } from "./noteLinkTarget";
import * as vscode from "vscode";
import { DocumentSyncManager } from "./documentSync";
import { VaultIndexService } from "./vault";
import { ImageIndexService } from "./vault/imageIndexService";
import { DEFAULT_THEME_ID, findTheme } from "./themes";
import { openSourceWithSelection, triggerNativeAi, addSelectionToChat } from "./ai/aiBridge";
import { aiLog } from "./ai/aiLog";
import { clampOffsetRange, cmToHostOffsets, hostToCmOffset } from "../shared/ranges";
import { DEFAULT_LINE_WIDTH, normalizeSettings } from "../shared/settings";
import { resolveNewNoteName } from "./vault/newNote";
import { attachmentName, dedupeName } from "./vault/attachment";
import { SerialQueue } from "./serialQueue";
import type {
  HostMsg,
  WebviewMsg,
  DocChange,
  DocVersion,
  Settings,
  ThemePayload,
} from "../shared/protocol";

// ---------------------------------------------------------------------------
// CSP nonce generator
// ---------------------------------------------------------------------------

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// Read + normalize the user-facing editor settings (column width, prose/code
// fonts) into the payload pushed to the webview. Validation/clamping lives in the
// pure, unit-tested `normalizeSettings` (../shared/settings).
function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration("ofm");
  return normalizeSettings({
    lineWidth: cfg.get<number>("lineWidth"),
    fontFamily: cfg.get<string>("fontFamily"),
    fontSize: cfg.get<number>("fontSize"),
    monospaceFontFamily: cfg.get<string>("monospaceFontFamily"),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The webview's offsets are CodeMirror's, where a CRLF is 1 character; the
// TextDocument counts it as 2. toHostOffsets maps the webview's offsets to the
// document's (toDocChanges maps back). Both are no-ops for LF documents.
function isCrlf(document: vscode.TextDocument): boolean {
  return document.eol === vscode.EndOfLine.CRLF;
}

function toHostOffsets(document: vscode.TextDocument, offsets: number[]): number[] {
  if (!isCrlf(document)) return offsets;
  return cmToHostOffsets(document.getText(), offsets);
}

// Each change's range and rangeOffset describe the document BEFORE the event
// (the event's document is already after it, and several changes share those
// coordinates), so the CodeMirror offset comes from the range's line numbers.
function toDocChanges(
  contentChanges: readonly vscode.TextDocumentContentChangeEvent[],
  crlf: boolean
): DocChange[] {
  return contentChanges.map((c) => ({
    from: crlf ? hostToCmOffset(c.rangeOffset, c.range.start.line) : c.rangeOffset,
    to: crlf
      ? hostToCmOffset(c.rangeOffset + c.rangeLength, c.range.end.line)
      : c.rangeOffset + c.rangeLength,
    insert: c.text,
  }));
}

type BufferedDocumentChange = {
  contentChanges: readonly vscode.TextDocumentContentChangeEvent[];
  version: number;
  text: string;
  crlf: boolean;
};
type PendingWebviewApply = {
  updates: readonly Update[];
  expected: string;
  baseVersion: number;
  events: BufferedDocumentChange[];
};

type PanelRecord = {
  document: vscode.TextDocument;
  panel: vscode.WebviewPanel;
};

// ---------------------------------------------------------------------------
// CustomTextEditorProvider
// ---------------------------------------------------------------------------

export class OfmCustomTextEditorProvider
  implements vscode.CustomTextEditorProvider
{
  /**
   * Registry of active webview panels, keyed by document URI string. Stores the
   * document too so an image-index change can recompute the image map for every
   * open editor (not just on text edits).
   */
  private panels: Map<string, Map<vscode.WebviewPanel, PanelRecord>> =
    new Map();

  /** Serializes webview edits per URI — the concurrent-edit corruption guard. */
  private editQueue = new SerialQueue();
  private readonly saveQueue = new SerialQueue();
  private nextFlushId = 0;
  private readonly flushWaiters = new Map<number, {
    panel: vscode.WebviewPanel;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  private readonly saving = new Set<string>();
  private readonly nativeSaves = new Map<string, { pending: Promise<void>; synchronized: boolean }>();

  /** Flush every live peer before inspecting the host queue. An empty queue
   * alone says nothing about messages still in transit from a webview. */
  private async synchronizeForSave(document: vscode.TextDocument): Promise<void> {
    const uri = document.uri.toString();
    await Promise.all([...this.panels.get(uri)?.keys() ?? []].filter(panel =>
      this.readyPanels.has(panel)).map(panel => new Promise<void>((resolve, reject) => {
      const requestId = ++this.nextFlushId;
      const timer = setTimeout(() => finish(new Error("A Live Preview did not respond to the save request. Your edits remain unsaved.")), 5000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.flushWaiters.delete(requestId);
        if (error) reject(error); else resolve();
      };
      this.flushWaiters.set(requestId, { panel, resolve: () => finish(), reject: finish });
      try {
        Promise.resolve(panel.webview.postMessage({ type: "flush", requestId } satisfies HostMsg))
          .then(sent => { if (!sent) finish(new Error("Live Preview closed before confirming its pending edits.")); }, error => finish(error));
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    })));
    await this.editQueue.drain(uri);
    if (this.conflicts.has(uri)) throw new Error("Live Preview has unsynchronized edits. Retry synchronization or save a recovery copy.");
  }

  /** Extension-owned saves must enter here, never call TextDocument.save()
   * before synchronization: that API skips clean host documents entirely. */
  async saveDocument(document: vscode.TextDocument): Promise<boolean> {
    const uri = document.uri.toString();
    return this.saveQueue.run(uri, async () => {
      await this.synchronizeForSave(document);
      // Keep later edits behind the disk write. Otherwise applyEdit can race
      // document.save() and turn a successful save into an unsaved document.
      return this.editQueue.run(uri, async () => {
        if (this.conflicts.has(uri)) throw new Error("Live Preview has unsynchronized edits.");
        this.saving.add(uri);
        try { return await document.save(); }
        finally { this.saving.delete(uri); }
      });
    });
  }

  private reportSaveError(error: unknown): void {
    void vscode.window.showErrorMessage("Flintmark could not finish saving: " + String(error));
  }
  private readonly queuedEdits = new Map<string, {
    panel: vscode.WebviewPanel;
    message: Extract<WebviewMsg, { type: "edit" }>;
    tail: Promise<unknown>;
  }>();
  private authorities = new Map<string, CollaborationAuthority>();
  private authorityDocuments = new WeakMap<CollaborationAuthority, vscode.TextDocument>();
  private conflicts = new Map<string, Map<Extract<WebviewMsg, { type: "edit" }>, vscode.WebviewPanel>>();
  private conflictNotifications = new Set<string>();
  private recoveryCopies = new Map<string, string[]>();
  private pendingUpdates = new Map<
    string,
    PendingWebviewApply
  >();

  private authority(document: vscode.TextDocument): CollaborationAuthority {
    const uri = document.uri.toString();
    let authority = this.authorities.get(uri);
    if (authority && this.authorityDocuments.get(authority) !== document &&
        this.conflicts.has(uri) && !this.pendingUpdates.has(uri) &&
        authority.doc.toString() !== document.getText().replace(/\r\n?|\n/g, "\n")) {
      // A closed document can change without emitting events to this provider.
      // Preserve its pending version separately instead of rebasing old offsets
      // into unrelated text when the document is reopened.
      this.recoveryCopies.set(uri, [...(this.recoveryCopies.get(uri) ?? []), this.recoveryText(uri)]);
      this.conflicts.delete(uri);
      this.authorities.delete(uri);
      authority = undefined;
      void vscode.window.showWarningMessage(
        "This file changed while closed. Flintmark preserved your unsynchronized edits in a recovery copy.",
        "Open Recovery Copy",
      ).then(action => { if (action) void this.openRecoveryCopy(uri); });
    }
    if (!authority) {
      authority = new CollaborationAuthority(
        document.getText(),
        isCrlf(document),
      );
      this.authorities.set(uri, authority);
    }
    if (this.authorityDocuments.get(authority) !== document) authority.crlf = isCrlf(document);
    this.authorityDocuments.set(authority, document);
    return authority;
  }
  private broadcastUpdates(
    document: vscode.TextDocument,
    updates: readonly Update[],
  ): void {
    const msg: HostMsg = {
      type: "syncUpdates",
      version: document.version,
      updates: encodeUpdates(updates),
    };
    for (const { panel } of this.panels
      .get(document.uri.toString())
      ?.values() ?? []) {
      if (this.readyPanels.has(panel)) panel.webview.postMessage(msg);
    }
  }

  /** Last image-map JSON sent per panel, to avoid redundant webview re-renders. */
  private lastImageMap: WeakMap<vscode.WebviewPanel, string> = new WeakMap();

  /** Panels that completed the webview ready/init handshake. */
  private readyPanels = new WeakSet<vscode.WebviewPanel>();

  /** Last requested source position for a document whose webview is opening. */
  private pendingReveals = new Map<string, { line: number; character: number }>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly syncManager: DocumentSyncManager,
    private readonly vault?: VaultIndexService,
    private readonly imageIndex?: ImageIndexService
  ) {
    // Global listener: reconcile external document changes into webviews.
    this.context.subscriptions.push(
      { dispose: () => {
        for (const waiter of this.flushWaiters.values()) waiter.reject(new Error("The editor was disposed during save."));
        this.nativeSaves.clear();
        this.saveQueue.clear();
      } },
      vscode.workspace.onDidChangeTextDocument((e) =>
        this.onDocumentChanged(e)
      ),
      vscode.workspace.onWillSaveTextDocument((e) => {
        const uri = e.document.uri.toString();
        if (this.saving.has(uri) || !this.panels.has(uri)) return;
        const record = { pending: Promise.resolve(), synchronized: false };
        const pending = this.synchronizeForSave(e.document);
        record.pending = pending;
        this.nativeSaves.set(uri, record);
        // VS Code gives save participants a shared 1.5 second budget. Return
        // before it expires and finish a slow remote flush after the native
        // write, instead of having VS Code permanently disable this listener.
        e.waitUntil(new Promise<vscode.TextEdit[]>(resolve => {
          let yielded = false;
          const timer = setTimeout(() => { yielded = true; resolve([]); }, 1000);
          void pending.then(() => {
            // Completion during an already-started disk write cannot prove
            // that write captured the synchronized document.
            if (!yielded) record.synchronized = true;
            clearTimeout(timer); resolve([]);
          }, error => {
            clearTimeout(timer); this.reportSaveError(error); resolve([]);
          });
        }));
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        const uri = document.uri.toString();
        const record = this.nativeSaves.get(uri);
        if (!record) return;
        this.nativeSaves.delete(uri);
        // A completed barrier needs no follow-up. Do not auto-save input that
        // arrives after an otherwise complete native save.
        if (record.synchronized) return;
        void record.pending.then(async () => {
          // A remote edit may finish after VS Code's save-participant budget.
          // Complete that save intent after its synchronized edits arrive.
          if (!document.isClosed) {
            await this.saveQueue.run(uri, () => this.editQueue.run(uri, async () => {
              if (this.conflicts.has(uri)) throw new Error("Live Preview has unsynchronized edits.");
              this.saving.add(uri);
              try {
                // Some providers clear dirty state when an older slow write
                // finishes. Force the follow-up even if save() would no-op.
                await vscode.commands.executeCommand("workbench.action.files.save", document.uri);
                if (document.isDirty) throw new Error("The document was not saved.");
              }
              finally { this.saving.delete(uri); }
            }));
          }
        }).catch(error => this.reportSaveError(error));
      })
    );

    // When the image index (re)builds — initial scan finishing, or an attachment
    // added/removed while a note's text is unchanged — recompute the image map
    // for every open editor so newly-resolved images appear without an edit.
    if (this.imageIndex) {
      this.context.subscriptions.push(
        this.imageIndex.onDidChange(() => {
          for (const { document, panel } of this.allPanelRecords()) {
            this.sendImageMap(document, panel);
          }
        })
      );
    }

    // Vault index (re)built — push fresh autocomplete data (notes + tags) to
    // every open editor so `[[` / `#` completion stays current.
    if (this.vault) {
      this.context.subscriptions.push(
        this.vault.onDidChange(() => {
          const vault = this.vault!.getVaultData();
          const msg: HostMsg = { type: "vaultData", vault };
          for (const { panel } of this.allPanelRecords()) {
            panel.webview.postMessage(msg);
          }
        })
      );
    }

    // Live theme switching: re-push the active theme to every open editor.
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("ofm.theme")) {
          for (const { panel } of this.allPanelRecords()) {
            const msg: HostMsg = {
              type: "themeChanged",
              theme: this.buildThemePayload(panel.webview),
            };
            panel.webview.postMessage(msg);
          }
        }
        if (
          e.affectsConfiguration("ofm.lineWidth") ||
          e.affectsConfiguration("ofm.fontFamily") ||
          e.affectsConfiguration("ofm.fontSize") ||
          e.affectsConfiguration("ofm.monospaceFontFamily")
        ) {
          // Push the FULL settings object so the webview can revert a CLEARED
          // font (omitted field → CSS variable removed) live, not just apply new
          // values.
          const settings: Settings = readSettings();
          for (const { panel } of this.allPanelRecords()) {
            panel.webview.postMessage({ type: "settingsChanged", settings } as HostMsg);
          }
        }
      })
    );
  }

  /** Resolve the active theme (`ofm.theme` setting) to a webview CSS URI. */
  private buildThemePayload(webview: vscode.Webview): ThemePayload {
    const id =
      vscode.workspace.getConfiguration("ofm").get<string>("theme") ??
      DEFAULT_THEME_ID;
    const theme = findTheme(id) ?? findTheme(DEFAULT_THEME_ID);
    const cssUri = theme
      ? webview
          .asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, theme.file)
          )
          .toString()
      : null;
    return { id: theme?.id ?? id, cssUri };
  }

  private *allPanelRecords(): Iterable<PanelRecord> {
    for (const records of this.panels.values()) {
      for (const record of records.values()) {
        yield record;
      }
    }
  }

  // -----------------------------------------------------------------------
  // resolveCustomTextEditor — called when VS Code opens our editor
  // -----------------------------------------------------------------------

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const uri = document.uri.toString();

    // Register panel so we can route external changes to it.
    let panelsForUri = this.panels.get(uri);
    if (!panelsForUri) {
      panelsForUri = new Map();
      this.panels.set(uri, panelsForUri);
    }
    panelsForUri.set(webviewPanel, { document, panel: webviewPanel });
    webviewPanel.onDidDispose(() => {
      for (const waiter of this.flushWaiters.values()) {
        if (waiter.panel === webviewPanel) waiter.reject(new Error("Live Preview closed during save synchronization."));
      }
      const records = this.panels.get(uri);
      records?.delete(webviewPanel);
      if (records?.size === 0) {
        this.panels.delete(uri);
        this.releaseAuthorityWhenIdle(uri);
      }
      // Drop the dedup cache so a REOPENED webview (which starts with an empty
      // imageMap) is re-sent the map even if the document text is unchanged.
      this.lastImageMap.delete(webviewPanel);
      this.readyPanels.delete(webviewPanel);
      if (records?.size === 0) this.pendingReveals.delete(uri);
    });

    // Configure webview
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.resourceRoots(document),
    };
    webviewPanel.webview.html = this.buildHtml(webviewPanel.webview);

    // Handle messages from the webview
    webviewPanel.webview.onDidReceiveMessage(
      (msg: WebviewMsg) => this.onWebviewMessage(document, webviewPanel, msg),
      undefined,
      this.context.subscriptions
    );
  }

  // -----------------------------------------------------------------------
  // HTML generation with strict CSP
  // -----------------------------------------------------------------------

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "webview.js")
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "webview.css")
    );
    const mermaidUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "out", "mermaid.js")
    );
    // Initial paint only — the webview re-applies the full settings (incl. fonts)
    // from the `init` message onto the document root, which overrides this.
    // lineWidth 0 = fill the editor width (no cap); >0 = centered column of N rem.
    const lineWidth = readSettings().lineWidth ?? DEFAULT_LINE_WIDTH;
    const lineWidthRule =
      lineWidth > 0 ? `:root { --file-line-width: ${lineWidth}rem; }` : "";

    // CSP: scripts only from our nonce; styles inline (CM6 needs this);
    // images and fonts restricted to webview cspSource.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' ${webview.cspSource}; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource};">
  <style nonce="${nonce}">
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      overflow: hidden;
      /* Driven by the active theme's Obsidian variables; VS Code as fallback. */
      background-color: var(--background-primary, var(--vscode-editor-background));
      color: var(--text-normal, var(--vscode-editor-foreground));
    }
    #editor {
      height: 100%;
    }
    /* NOTE: all .cm-* editor styling lives in the CM6 theme layer (markdownTheme,
       via EditorView.theme) — NOT here. A host stylesheet rule for .cm-content /
       .cm-scroller ties on specificity with CM6's own base theme but loses on
       order (CM6 injects later), so it would be silently overridden (that bug made
       the page read edge-to-edge). The host only owns the page container above and
       the dynamic readable-column variable below. */
    ${lineWidthRule}
  </style>
  <link rel="stylesheet" href="${cssUri}">
  <meta name="ofm-nonce" content="${nonce}">
  <meta name="ofm-mermaid-uri" content="${mermaidUri}">
</head>
<body>
  <div id="editor"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  // -----------------------------------------------------------------------
  // Webview message dispatch
  // -----------------------------------------------------------------------

  private async onWebviewMessage(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    msg: WebviewMsg
  ): Promise<void> {
    switch (msg.type) {
      case "flushed": {
        const waiter = this.flushWaiters.get(msg.requestId);
        if (waiter?.panel === panel) waiter.resolve();
        return;
      }
      case "ready":
        await this.editQueue.drain(document.uri.toString());
        return this.handleReady(document, panel);

      case "edit":
        // Serialize: never apply concurrently (fast typing would race/corrupt).
        this.enqueueEdit(document, panel, msg);
        return;

      case "requestSave":
        try {
          if (!await this.saveDocument(document)) throw new Error("The document was not saved.");
        } catch (error) { this.reportSaveError(error); }
        return;

      case "requestUndo":
        await this.editQueue.run(document.uri.toString(), async () => {
          await vscode.commands.executeCommand("undo");
        });
        return;

      case "requestRedo":
        await this.editQueue.run(document.uri.toString(), async () => {
          await vscode.commands.executeCommand("redo");
        });
        return;

      case "selectionChanged":
        // Slice 1: receive but do nothing (Selection Bridge seat).
        return;

      case "toggleTask":
        return this.handleToggleTask(document, msg.from, msg.to);

      case "openLink":
        return this.handleOpenLink(document, msg.target);

      case "saveAttachment":
        return this.handleSaveAttachment(document, panel, msg);

      case "aiEditSelection":
        aiLog(
          `▶ aiEditSelection received from webview: mode=${msg.mode} from=${msg.from} to=${msg.to}`
        );
        return this.handleAiEditSelection(document, msg.from, msg.to, msg.mode);

      case "log":
        console.log(`[webview:${msg.level}] ${msg.msg}`);
        return;

      case "warn":
        vscode.window.showWarningMessage(`Flintmark: ${msg.message}`);
        return;
    }
  }

  // -----------------------------------------------------------------------
  // Handle ready → send init with full document text
  // -----------------------------------------------------------------------

  private handleReady(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel
  ): void {
    const text = document.getText();
    const version: DocVersion = document.version;
    const settings: Settings = readSettings();
    const theme = this.buildThemePayload(panel.webview);

    const initMsg: HostMsg = {
      type: "init",
      syncVersion: this.authority(document).version,
      uri: document.uri.toString(),
      version,
      text,
      settings,
      theme,
      vault: this.vault?.getVaultData(),
    };

    panel.webview.postMessage(initMsg);
    this.readyPanels.add(panel);
    if (this.conflicts.has(document.uri.toString())) this.notifyConflict(document);
    const pendingReveal = this.pendingReveals.get(document.uri.toString());
    if (pendingReveal) {
      this.pendingReveals.delete(document.uri.toString());
      this.postReveal(panel, pendingReveal.line, pendingReveal.character);
    }
    this.imageIndex?.ensureFreshForDocument(document.uri, "webview-ready");
    // FORCE the image map to this freshly-ready webview: a pre-ready send (e.g.
    // an imageIndex.onDidChange that fired before `ready`) is dropped by the
    // webview (view still null) yet updated lastImageMap, which would dedupe-skip
    // this send and leave the ready webview with no images. Clearing the cache
    // first guarantees delivery once the webview can actually apply it.
    this.lastImageMap.delete(panel);
    this.sendImageMap(document, panel);
  }

  // -----------------------------------------------------------------------
  // Handle edit from webview → minimal-range WorkspaceEdit
  // -----------------------------------------------------------------------

  /** Rebase each panel's versioned updates, then apply them serially per URI.
   * Overlapping batches are deduplicated by the authority, so a frame can send
   * input immediately without waiting for an earlier acknowledgment.
   */
  private enqueueEdit(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    msg: Extract<WebviewMsg, { type: "edit" }>,
  ): void {
    const uri = document.uri.toString();
    const waiting = this.queuedEdits.get(uri);
    if (waiting && waiting.panel === panel &&
        waiting.tail === this.editQueue.idle(uri) &&
        extendsPendingUpdates(waiting.message, msg)) {
      // Both messages are already in the host. Keep the complete newest batch
      // without delaying input or moving it across another panel or command.
      waiting.message = msg;
      return;
    }
    const batch = { panel, message: msg, tail: this.editQueue.idle(uri) };
    const queued = this.editQueue.run(uri, async () => {
      if (this.queuedEdits.get(uri) === batch) this.queuedEdits.delete(uri);
      msg = batch.message;
      // A rejected WorkspaceEdit must never acknowledge an optimistic edit.
      // Rebase and retry transient version conflicts while this queue owns it,
      // including when the originating panel closes before the acknowledgment.
      const deadline = Date.now() + 2000;
      for (let attempt = 0; ; attempt++) {
        const authority = this.authority(document);
        const updates = authority.prepare(msg.syncVersion, decodeUpdates(msg.updates));
        if (!updates.length) return;
        let combined = ChangeSet.empty(authority.doc.length);
        for (const update of updates) combined = combined.compose(update.changes);
        const changes: DocChange[] = [];
        combined.iterChanges((from, to, _fromB, _toB, insert) =>
          changes.push({ from, to, insert: insert.toString() }),
        );
        if (combined.empty) {
          authority.commit(updates);
          this.broadcastUpdates(document, updates);
          return;
        }
        const pending: PendingWebviewApply = {
          updates,
          expected: combined.apply(authority.doc).toString(),
          baseVersion: document.version,
          events: [],
        };
        this.pendingUpdates.set(uri, pending);
        let applied = false;
        try {
          applied = await this.applyWebviewEdit(document, changes);
        } finally {
          this.pendingUpdates.delete(uri);
          this.reconcileApplyResult(document, pending, applied);
        }
        if (applied) return;
        if (document.version === pending.baseVersion || Date.now() >= deadline) {
          throw new Error("VS Code could not apply your edit. Your local edits are still pending.");
        }
        // Yield during transient contention; a sustained conflict is retained
        // below with its authority history and a visible Retry action.
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(10 * (attempt + 1), 100)),
        );
      }
    });
    batch.tail = queued;
    this.queuedEdits.set(uri, batch);
    void queued
      .then(() => {
        const conflicts = this.conflicts.get(uri);
        if (conflicts) {
          const authority = this.authorities.get(uri);
          for (const failed of conflicts.keys()) {
            try {
              if (authority && !authority.prepare(failed.syncVersion, decodeUpdates(failed.updates)).length) conflicts.delete(failed);
            } catch (error) {
              console.error("[ofm] retained edit could not be checked for acknowledgment", error);
            }
          }
          if (!conflicts.size) this.conflicts.delete(uri);
        }
        if (!this.panels.has(uri)) this.releaseAuthorityWhenIdle(uri);
      })
      .catch((error: unknown) => {
        const conflicts = this.conflicts.get(uri) ?? new Map();
        conflicts.set(msg, panel);
        this.conflicts.set(uri, conflicts);
        const message = String(error);
        console.error("[ofm] collaboration edit failed", error);
        if (this.panels.get(uri)?.has(panel)) {
          void Promise.resolve(panel.webview.postMessage({
            type: "syncError",
            message,
          } satisfies HostMsg)).catch(() => undefined);
        }
        this.notifyConflict(document);
      });
  }

  private releaseAuthorityWhenIdle(uri: string): void {
    const tail = this.editQueue.idle(uri);
    void tail.then(() => {
      if (this.editQueue.idle(uri) !== tail) {
        this.releaseAuthorityWhenIdle(uri);
      } else if (!this.panels.has(uri) && !this.conflicts.has(uri)) {
        this.authorities.delete(uri);
      }
    }).catch(() => {
      // Failed edits retain history; unrelated command failures do not.
      if (!this.panels.has(uri) && !this.conflicts.has(uri)) this.authorities.delete(uri);
    });
  }

  private recoveryText(uri: string): string {
    const authority = this.authorities.get(uri);
    if (!authority) return this.recoveryCopies.get(uri)?.at(-1) ?? "";
    const copy = new CollaborationAuthority(authority.doc.toString(), authority.crlf);
    copy.updates.push(...authority.updates);
    for (const msg of this.conflicts.get(uri)?.keys() ?? []) {
      copy.commit(copy.prepare(msg.syncVersion, decodeUpdates(msg.updates)));
    }
    return copy.crlf ? copy.doc.toString().replace(/\n/g, "\r\n") : copy.doc.toString();
  }

  private async openRecoveryCopy(uri: string): Promise<void> {
    const texts = [...(this.recoveryCopies.get(uri) ?? [])];
    if (this.conflicts.has(uri)) texts.push(this.recoveryText(uri));
    for (const text of new Set(texts)) {
      const copy = await vscode.workspace.openTextDocument({ language: "markdown", content: text });
      await vscode.window.showTextDocument(copy, { preview: false });
    }
  }

  private async retryConflicts(document: vscode.TextDocument): Promise<void> {
    const current = document.isClosed ? await vscode.workspace.openTextDocument(document.uri) : document;
    this.authority(current);
    for (const [msg, panel] of this.conflicts.get(current.uri.toString()) ?? []) {
      this.enqueueEdit(current, panel, msg);
    }
  }

  private notifyConflict(document: vscode.TextDocument): void {
    const uri = document.uri.toString();
    if (this.conflictNotifications.has(uri)) return;
    this.conflictNotifications.add(uri);
    void vscode.window.showErrorMessage(
      "Flintmark could not synchronize all edits. Native saves include only synchronized text. Retry or save a recovery copy before closing the application.",
      "Retry",
      "Open Recovery Copy",
    ).then((action) => {
      this.conflictNotifications.delete(uri);
      if (action === "Retry") {
        void this.retryConflicts(document);
      } else if (action === "Open Recovery Copy") {
        void this.openRecoveryCopy(uri);
      }
    });
  }

  private applyExternalChange(document: vscode.TextDocument, event: BufferedDocumentChange): void {
    const authority = this.authority(document);
    // VS Code represents an EOL-only conversion as a full-document replace.
    // Its normalized text has not changed, so rebasing it as a replacement
    // would incorrectly move concurrent insertions to the end of the document.
    if (event.crlf !== authority.crlf && event.text === authority.doc.toString()) {
      authority.crlf = event.crlf;
      return;
    }
    const changes = ChangeSet.of(
      toDocChanges(event.contentChanges, authority.crlf),
      authority.doc.length,
    );
    authority.crlf = event.crlf;
    if (changes.empty) return;
    const updates = [{ clientID: "host", changes }];
    authority.commit(updates);
    this.broadcastUpdates(document, updates);
  }

  private reconcileApplyResult(
    document: vscode.TextDocument,
    pending: PendingWebviewApply,
    applied: boolean,
  ): void {
    const authority = this.authority(document);
    let acknowledged = false;
    if (applied) this.syncManager.shouldSuppress(document.uri.toString());
    for (const event of pending.events) {
      // The real API validates the captured document version. Only a successful
      // apply can own its next-version event; equal text from a rejected apply
      // is an independent host change, not an acknowledgment.
      if (applied && !acknowledged &&
          event.version === pending.baseVersion + 1 && event.text === pending.expected) {
        authority.commit(pending.updates);
        authority.crlf = event.crlf;
        this.broadcastUpdates(document, pending.updates);
        acknowledged = true;
      } else {
        this.applyExternalChange(document, event);
      }
    }
    if (applied && !acknowledged) {
      // A nonempty replacement can leave the text identical and emit no event.
      if (pending.events.length === 0 && authority.doc.toString() === pending.expected) {
        authority.commit(pending.updates);
        this.broadcastUpdates(document, pending.updates);
      } else {
        throw new Error("The applied edit did not produce its expected document change.");
      }
    }
  }

  private async applyWebviewEdit(
    document: vscode.TextDocument,
    changes: DocChange[],
  ): Promise<boolean> {
    const uri = document.uri.toString();

    // Minimal-range WorkspaceEdit — never a full-document replace. Offsets are
    // resolved against the CURRENT document, which (because we serialize) already
    // contains every prior webview edit, so they map correctly.
    const edit = new vscode.WorkspaceEdit();
    const offsets = toHostOffsets(document, changes.flatMap((ch) => [ch.from, ch.to]));
    changes.forEach((ch, i) => {
      edit.replace(
        document.uri,
        new vscode.Range(
          document.positionAt(offsets[2 * i]),
          document.positionAt(offsets[2 * i + 1])
        ),
        ch.insert
      );
    });

    // Mark this URI so the resulting onDidChangeTextDocument is suppressed.
    this.syncManager.markSuppressNext(uri);

    let applied: boolean;
    try {
      applied = await vscode.workspace.applyEdit(edit);
    } catch (error) {
      this.syncManager.cancelSuppress(uri);
      throw error;
    }
    if (!applied) {
      // No change event will arrive to consume the mark — roll it back so it
      // doesn't leak onto the next genuinely-external change.
      this.syncManager.cancelSuppress(uri);
      console.warn("[ofm] WorkspaceEdit was not applied");
    }
    return applied;
  }

  // -----------------------------------------------------------------------
  // Legacy host-side task toggles; current webviews submit versioned edits.
  // -----------------------------------------------------------------------
  // Handle toggleTask — flip [ ] <-> [x] at the marker range
  // -----------------------------------------------------------------------

  private async handleToggleTask(
    document: vscode.TextDocument,
    from: number,
    to: number
  ): Promise<void> {
    const [hostFrom, hostTo] = toHostOffsets(document, [from, to]);
    const range = new vscode.Range(
      document.positionAt(hostFrom),
      document.positionAt(hostTo)
    );
    const marker = document.getText(range);
    const toggled = /\[[xX]\]/.test(marker) ? "[ ]" : "[x]";
    if (toggled === marker) return;

    // Do NOT suppress: this host-originated change must echo back to the webview
    // so the checkbox re-renders from the new source.
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, range, toggled);
    await vscode.workspace.applyEdit(edit);
  }

  // -----------------------------------------------------------------------
  // Handle openLink — naive filename match in workspace (Slice 1)
  // -----------------------------------------------------------------------

  private async handleOpenLink(
    document: vscode.TextDocument,
    target: string
  ): Promise<void> {
    if (!target) return;

    // External links ([text](https://…), <mailto:…>, autolinks): open in the
    // OS browser / mail client rather than trying to resolve a vault note.
    if (/^(https?:|mailto:|tel:|vscode:)/i.test(target)) {
      try {
        await vscode.env.openExternal(vscode.Uri.parse(target));
      } catch {
        vscode.window.showWarningMessage(`Could not open link: ${target}`);
      }
      return;
    }

    // A wikilink target may carry a heading anchor (`#…`), a block anchor
    // (`#^id` or the bare `^id`), and/or an alias (`|…`) — strip them all before
    // resolving so `[[Foo#Section]]` / `[[Foo^abc]]` resolve to Foo (not searched
    // as `Foo#Section.md`, which would miss and wrongly offer to create a
    // duplicate). An anchor-only `[[#heading]]` / `[[^id]]` has no note to open.
    const note = noteLinkTarget(target);
    if (!note) return;

    // Markdown paths are relative to the current document, not a workspace
    // basename search. Resolve them first, including explicit .md extensions
    // and percent-encoded names; Uri keeps remote workspace schemes intact.
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
    const base = note.startsWith("/") && workspaceRoot
      ? workspaceRoot
      : vscode.Uri.joinPath(document.uri, "..");
    for (const candidate of noteLinkCandidates(note.replace(/^\/+/, ""))) {
      const uri = vscode.Uri.joinPath(base, candidate);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.File) === 0) continue;
      } catch {
        continue;
      }
      await vscode.commands.executeCommand("vscode.openWith", uri, "ofm.livePreview");
      return;
    }

    // Prefer the Vault Index (case-insensitive basename match, alias-aware).
    const viaIndex = this.vault?.resolveLinkUri(note);
    if (viaIndex) {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        viaIndex,
        "ofm.livePreview"
      );
      return;
    }

    // Fallback: naive workspace filename match — both supported extensions, so
    // an existing `Foo.markdown` isn't treated as missing (the index scans .md).
    const files = await vscode.workspace.findFiles(
      `**/${note.replace(/\.(md|markdown)$/i, "")}.{md,markdown}`,
      undefined,
      1
    );
    if (files.length > 0) {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        files[0],
        "ofm.livePreview"
      );
      return;
    }

    // Unresolved: offer to create the note next to the current one (Obsidian-like).
    await this.offerCreateNote(document, note);
  }

  /**
   * Create-on-click for an unresolved `[[wikilink]]`: confirm, write a stub
   * `<basename>.md` in the current note's folder, then open it. The filename is
   * derived by the pure `resolveNewNoteName` (basename only — no directories,
   * no path traversal).
   */
  private async offerCreateNote(
    document: vscode.TextDocument,
    target: string
  ): Promise<void> {
    const filename = resolveNewNoteName(target);
    if (!filename) {
      vscode.window.showInformationMessage(`Could not find note: ${target}`);
      return;
    }
    const dir = vscode.Uri.joinPath(document.uri, "..");
    const fileUri = vscode.Uri.joinPath(dir, filename);

    // Already on disk (e.g. resolver miss / race) → just open it.
    let exists = false;
    try {
      await vscode.workspace.fs.stat(fileUri);
      exists = true;
    } catch {
      /* not found — we'll offer to create */
    }

    if (!exists) {
      const CREATE = "Create note";
      const choice = await vscode.window.showInformationMessage(
        `"${target}" doesn't exist yet. Create it?`,
        CREATE
      );
      if (choice !== CREATE) return;
      const title = filename.replace(/\.md$/i, "");
      const content = new TextEncoder().encode(`# ${title}\n\n`);
      try {
        await vscode.workspace.fs.writeFile(fileUri, content);
      } catch (e) {
        vscode.window.showErrorMessage(
          `Flintmark: couldn't create ${filename}: ${(e as Error).message}`
        );
        return;
      }
    }

    await vscode.commands.executeCommand("vscode.openWith", fileUri, "ofm.livePreview");
  }

  // -----------------------------------------------------------------------
  // Image paste/drop: write the bytes as an attachment next to the note, then
  // tell the webview the embed name to insert. Image MIME types only (the pure
  // attachmentName refuses anything else), with a size cap.
  // -----------------------------------------------------------------------

  private static readonly MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;

  private async handleSaveAttachment(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    msg: Extract<WebviewMsg, { type: "saveAttachment" }>
  ): Promise<void> {
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

    const name = attachmentName(msg.filename, msg.mime, stamp);
    if (!name) {
      vscode.window.showWarningMessage("Flintmark: only image attachments can be pasted.");
      return;
    }

    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(Buffer.from(msg.dataBase64, "base64"));
    } catch {
      return;
    }
    if (bytes.length === 0 || bytes.length > OfmCustomTextEditorProvider.MAX_ATTACHMENT_BYTES) {
      vscode.window.showWarningMessage("Flintmark: attachment is empty or too large (max 24 MB).");
      return;
    }

    const dir = vscode.Uri.joinPath(document.uri, "..");
    let finalName = name;
    let target = vscode.Uri.joinPath(dir, finalName);
    for (let i = 1; i < 1000 && (await this.uriExists(target)); i++) {
      finalName = dedupeName(name, i);
      target = vscode.Uri.joinPath(dir, finalName);
    }
    // The loop can exit at the cap with the last candidate still taken — never
    // overwrite an existing attachment in that (pathological) case.
    if (await this.uriExists(target)) {
      vscode.window.showErrorMessage(
        "Flintmark: too many attachments with that name — rename and retry."
      );
      return;
    }

    try {
      await vscode.workspace.fs.writeFile(target, bytes);
    } catch (e) {
      vscode.window.showErrorMessage(
        `Flintmark: couldn't save attachment: ${(e as Error).message}`
      );
      return;
    }

    this.imageIndex?.ensureFreshForDocument(document.uri, "attachment-saved");
    const reply: HostMsg = { type: "attachmentSaved", requestId: msg.requestId, embed: finalName };
    panel.webview.postMessage(reply);
  }

  private async uriExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // AI Selection Bridge: relocate the Live Preview selection into the real
  // source editor, then hand off to the host's native AI (see ai/aiBridge.ts).
  // Every node degrades gracefully: a failed flip warns; a missing AI command
  // just leaves the user in source with the selection set.
  // -----------------------------------------------------------------------

  private async handleAiEditSelection(
    document: vscode.TextDocument,
    from: number,
    to: number,
    mode: "edit" | "chat"
  ): Promise<void> {
    // Node 1+2: clamp offsets to the document (selection == source offsets,
    // once mapped from CodeMirror's to the document's).
    const len = document.getText().length;
    const [hostFrom, hostTo] = toHostOffsets(document, [from, to]);
    const { from: a, to: bClamped } = clampOffsetRange(hostFrom, hostTo, len);
    const sel = new vscode.Selection(
      document.positionAt(a),
      document.positionAt(bClamped)
    );

    const cfg = vscode.workspace.getConfiguration("ofm");
    const selText = document.getText(sel);
    aiLog(
      `handle: mode=${mode}, selection ${selText.length} chars: ${JSON.stringify(selText.slice(0, 60))}${selText.length > 60 ? "…" : ""}`
    );
    aiLog(
      `handle: config chatBridge=${cfg.get("ai.chatBridge") ?? "split"} sourceLayout=${cfg.get("ai.sourceLayout") ?? "replace"} trigger=${cfg.get("ai.trigger") ?? "auto"} chatCommand=${cfg.get("ai.chatCommand") || "—"} triggerCommand=${cfg.get("ai.triggerCommand") || "—"}`
    );

    if (mode === "chat") {
      const inplace = cfg.get<string>("ai.chatBridge") === "inplace";
      const chatCmd = cfg.get<string>("ai.chatCommand") || undefined;
      if (inplace) {
        // In-place: flip THIS tab to source (no side split), add to chat, flip
        // back to Live. Trade-off: returning to Live recreates the webview (a
        // brief re-render).
        const ed = await openSourceWithSelection(document, sel, "replace");
        if (!ed) {
          vscode.window.showWarningMessage("Flintmark: couldn't open the source for AI.");
          return;
        }
        const ok = await addSelectionToChat(chatCmd);
        await vscode.commands.executeCommand("vscode.openWith", document.uri, "ofm.livePreview");
        if (!ok) {
          vscode.window.setStatusBarMessage(
            "Flintmark: couldn't add to chat — open your AI chat and retry.",
            5000
          );
        }
        return;
      }
      // split (default): keep the Live Preview tab UNTOUCHED (no re-render) by
      // opening a transient SIDE editor just long enough to give the native chat
      // a real selection, then closing it.
      const editor = await openSourceWithSelection(document, sel, "beside");
      if (!editor) {
        vscode.window.showWarningMessage("Flintmark: couldn't open the source for AI.");
        return;
      }
      const ok = await addSelectionToChat(chatCmd);
      await this.closeTextEditorsFor(document.uri);
      if (!ok) {
        vscode.window.setStatusBarMessage(
          "Flintmark: couldn't add to chat — open your AI chat and retry.",
          5000
        );
      }
      return;
    }

    // Edit mode: the user needs to stay in source to interact with the inline AI,
    // so replace the tab (configurable to a side split).
    const layout = cfg.get<string>("ai.sourceLayout") === "beside" ? "beside" : "replace";
    const editor = await openSourceWithSelection(document, sel, layout);
    if (!editor) {
      vscode.window.showWarningMessage(
        "Flintmark: couldn't open the Markdown source for AI."
      );
      return;
    }

    // Node 4 (edit): hand off to native inline AI (auto-detect, with fallbacks).
    const trigger = cfg.get<string>("ai.trigger") === "manual" ? "manual" : "auto";
    const preferred = cfg.get<string>("ai.triggerCommand") || undefined;
    await triggerNativeAi(trigger, preferred);

    // Node 5: offer a one-click "accept & return" / "return" (we cannot observe
    // the host's internal Accept, so we expose explicit controls).
    void this.offerReturnControls(document.uri, "edit");
  }

  /** Close any plain TEXT editor tabs for `uri` (used to remove the transient
   *  source split opened for Add-to-Chat). Leaves our custom-editor tab intact. */
  private async closeTextEditorsFor(uri: vscode.Uri): Promise<void> {
    const target = uri.toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputText && input.uri.toString() === target) {
          try {
            await vscode.window.tabGroups.close(tab);
          } catch {
            /* best-effort */
          }
        }
      }
    }
  }

  private async offerReturnControls(
    uri: vscode.Uri,
    mode: "edit" | "chat"
  ): Promise<void> {
    const RETURN = "↩ Return to preview";
    if (mode === "chat") {
      const choice = await vscode.window.showInformationMessage(
        "Flintmark: selection added to chat.",
        RETURN
      );
      if (choice === RETURN) {
        await vscode.commands.executeCommand("ofm.returnToLivePreview");
      }
      return;
    }
    const ACCEPT = "✓ Accept & return to preview";
    const choice = await vscode.window.showInformationMessage(
      "Flintmark: editing the Markdown source with AI.",
      ACCEPT,
      RETURN
    );
    if (choice === ACCEPT) {
      await vscode.commands.executeCommand("ofm.acceptAiAndReturn");
    } else if (choice === RETURN) {
      await vscode.commands.executeCommand("ofm.returnToLivePreview");
    }
  }

  /**
   * Reveal a source position in the matching Live Preview. When the document is
   * not open yet, retain the request until its webview completes init so the
   * message cannot be dropped during startup.
   */
  public async revealPositionInDocument(
    uri: vscode.Uri,
    line: number,
    character: number
  ): Promise<void> {
    const key = uri.toString();
    const records = [...(this.panels.get(key)?.values() ?? [])];
    const hasLiveTab = vscode.window.tabGroups.all.some((group) =>
      group.tabs.some((tab) => tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === "ofm.livePreview" && tab.input.uri.toString() === key),
    );
    // Switching to source can leave a valid preview tab hidden. Reveal that
    // existing tab; disposing it races the host closing/reopening the same tab.
    const record = hasLiveTab ? (
      records.find((candidate) => candidate.panel.active) ??
      records.find((candidate) => candidate.panel.visible) ?? records[0]
    ) : undefined;

    if (record) {
      record.panel.reveal(record.panel.viewColumn, false);
      if (this.readyPanels.has(record.panel)) {
        this.postReveal(record.panel, line, character);
      } else {
        this.pendingReveals.set(key, { line, character });
      }
      return;
    }

    // A Live → Code replacement can leave a non-visible WebviewPanel record
    // alive even though no tab can reveal it. supportsMultipleEditors=false
    // then prevents openWith from creating the replacement. Dispose only these
    // orphaned/hidden records before reopening the requested document.
    for (const hidden of records) hidden.panel.dispose();
    if (records.length > 0) {
      // WebviewPanel disposal is reported asynchronously by some VS Code hosts.
      // Let that event drain before openWith, otherwise the host can still see
      // supportsMultipleEditors=false ownership and silently swallow the open.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    this.pendingReveals.set(key, { line, character });
    try {
      const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (
        active instanceof vscode.TabInputText &&
        active.uri.toString() === key
      ) {
        await vscode.commands.executeCommand("ofm.openAsLivePreview");
      } else {
        await vscode.commands.executeCommand("vscode.openWith", uri, "ofm.livePreview");
      }
      // Live → Code can leave a ready but hidden panel record briefly alive.
      // `openWith` may reveal/reuse it without another ready handshake, so drain
      // the pending request here when handleReady did not already consume it.
      const pending = this.pendingReveals.get(key);
      if (pending) {
        const opened = [...(this.panels.get(key)?.values() ?? [])].find(
          (candidate) => candidate.panel.active || candidate.panel.visible
        );
        if (opened && this.readyPanels.has(opened.panel)) {
          this.pendingReveals.delete(key);
          this.postReveal(opened.panel, pending.line, pending.character);
        }
      }
    } catch (error) {
      this.pendingReveals.delete(key);
      throw error;
    }
  }

  private postReveal(
    panel: vscode.WebviewPanel,
    line: number,
    character: number
  ): void {
    const msg: HostMsg = { type: "revealPosition", line, character };
    void panel.webview.postMessage(msg);
  }

  /** The webview panel for the active Live Preview tab (or the sole panel). */
  private activePanel(): vscode.WebviewPanel | undefined {
    const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    let uri: string | undefined;
    if (active instanceof vscode.TabInputCustom && active.viewType === "ofm.livePreview") {
      uri = active.uri.toString();
    }
    const records = uri
      ? [...(this.panels.get(uri)?.values() ?? [])]
      : [...this.allPanelRecords()];
    if (records.length === 0) return undefined;
    return (
      records.find((record) => record.panel.active)?.panel ??
      records.find((record) => record.panel.visible)?.panel ??
      records[0].panel
    );
  }

  /** Palette/command entry: ask the active Live Preview panel for its selection
   *  so the host can run the bridge. Returns true if a panel was messaged. */
  public requestAiEditOnActivePanel(mode: "edit" | "chat"): boolean {
    const panel = this.activePanel();
    if (!panel) return false;
    const msg: HostMsg = { type: "requestAiEdit", mode };
    void panel.webview.postMessage(msg);
    return true;
  }

  /**
   * Mod-F with focus outside the webview (Explorer single-click keeps focus in
   * the tree). VS Code's own Find runs for any open text editor, but never
   * reaches a custom editor, so focus the active Live Preview and open its find.
   */
  public async openFindOnActivePanel(): Promise<boolean> {
    const panel = this.activePanel();
    if (!panel) return false;
    // reveal() is a no-op for the already-active panel, so it can't pull focus
    // out of the Explorer; focusing the editor group moves it into the webview.
    if (panel.active) {
      await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    } else {
      panel.reveal(undefined, false);
    }
    const msg: HostMsg = { type: "openFind" };
    void panel.webview.postMessage(msg);
    return true;
  }

  // -----------------------------------------------------------------------
  // Image resolution: map raw `![](src)` paths to webview-safe URIs
  // -----------------------------------------------------------------------

  private resourceRoots(document: vscode.TextDocument): vscode.Uri[] {
    // MUST include the extension URI, or out/webview.js can no longer load
    // (setting localResourceRoots overrides the permissive default).
    const roots: vscode.Uri[] = [
      this.context.extensionUri,
      vscode.Uri.joinPath(document.uri, ".."),
    ];
    for (const f of vscode.workspace.workspaceFolders ?? []) roots.push(f.uri);
    return roots;
  }

  private sendImageMap(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel
  ): void {
    const text = document.getText();
    const dir = vscode.Uri.joinPath(document.uri, "..");
    const map: Record<string, string> = {};

    // Legacy resolution: relative to the document's folder (what we did before the
    // vault-wide index). Used when the ImageIndex can't resolve (not ready /
    // over-cap / outside a workspace root / genuinely unresolved) — no regression
    // for same-folder images and existing relative paths.
    const legacy = (src: string): string => {
      const fileUri = src.startsWith("/")
        ? vscode.Uri.file(src)
        : vscode.Uri.joinPath(dir, src);
      return panel.webview.asWebviewUri(fileUri).toString();
    };

    // `key` is what the WEBVIEW looks up (raw markdown src, or the embed target);
    // `ref` is the path we hand the resolver. SYNCHRONOUS — no I/O here.
    const put = (key: string, ref: string, requireImageExt: boolean): void => {
      if (map[key] !== undefined) return;
      if (/^(https?:|data:)/.test(ref)) {
        map[key] = ref;
        return;
      }
      const hit = this.imageIndex?.resolveImage(document.uri, ref, requireImageExt);
      map[key] = hit ? panel.webview.asWebviewUri(hit).toString() : legacy(ref);
    };

    // Standard images: ![alt](src) — key === the raw src (matches the webview).
    const re = /!\[[^\]]*\]\(\s*([^)\s]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) put(m[1], m[1], false);

    // Image embeds: ![[target#anchor|size]] — key === the webview's
    // `inner.split("|")[0].split("#")[0].trim()`; only image-extension targets
    // are images (note embeds render as chips, not here).
    const embedRe = /!\[\[([^\]]+?)\]\]/g;
    while ((m = embedRe.exec(text)) !== null) {
      const target = m[1].split("|")[0].split("#")[0].trim();
      if (/\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i.test(target)) put(target, target, true);
    }

    // Stable serialization (sorted keys) so insertion-order churn never reposts;
    // a changed resolved URI for the same key still reposts (index events).
    const json = JSON.stringify(map, Object.keys(map).sort());
    if (this.lastImageMap.get(panel) === json) return; // unchanged → skip
    this.lastImageMap.set(panel, json);
    const msg: HostMsg = { type: "imageMap", map };
    panel.webview.postMessage(msg);
  }

  // -----------------------------------------------------------------------
  // onDidChangeTextDocument → reconcile external changes into webview
  // -----------------------------------------------------------------------

  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    const uri = e.document.uri.toString();
    const records = [...(this.panels.get(uri)?.values() ?? [])];

    // Refresh image resolution on every change (images can be typed/edited);
    // sendImageMap only posts when the set of image srcs actually changed.
    for (const { panel } of records) {
      this.sendImageMap(e.document, panel);
    }

    const authority = this.authorities.get(uri);
    if (authority) {
      const crlf = isCrlf(e.document);
      if (e.contentChanges.length === 0 && authority.crlf === crlf) return;
      const event: BufferedDocumentChange = {
        contentChanges: e.contentChanges,
        version: e.document.version,
        text: e.document.getText().replace(/\r\n?|\n/g, "\n"),
        crlf,
      };
      const pending = this.pendingUpdates.get(uri);
      if (pending) pending.events.push(event);
      else this.applyExternalChange(e.document, event);
      return;
    }

    // Echo suppression: if this change originated from our own webview edit,
    // do NOT send it back (prevents echo loop and cursor jumps).
    if (this.syncManager.shouldSuppress(uri)) {
      return;
    }

    if (records.length === 0) return;

    const changes = toDocChanges(e.contentChanges, isCrlf(e.document));

    // If the document was completely replaced (e.g. external reload),
    // use replaceAll to avoid cascading incremental changes.
    if (changes.length === 1 && changes[0].from === 0) {
      const text = e.document.getText();
      // Heuristic: if the replace covers most of the document, treat as replaceAll.
      // (`to` is in CodeMirror offsets, `text` in document offsets: compare in the latter.)
      const hostTo = e.contentChanges[0].rangeOffset + e.contentChanges[0].rangeLength;
      if (hostTo >= text.length || changes[0].insert === text) {
        const replaceAllMsg: HostMsg = {
          type: "replaceAll",
          version: e.document.version,
          text,
        };
        for (const { panel } of records) {
          panel.webview.postMessage(replaceAllMsg);
        }
        return;
      }
    }

    // Standard incremental reconciliation.
    const applyMsg: HostMsg = {
      type: "applyEdit",
      version: e.document.version,
      origin: "host",
      changes,
    };
    for (const { panel } of records) {
      panel.webview.postMessage(applyMsg);
    }
  }
}

import * as vscode from "vscode";
import { DocumentSyncManager } from "./documentSync";
import { VaultIndexService } from "./vault";
import { ImageIndexService } from "./vault/imageIndexService";
import { DEFAULT_THEME_ID, findTheme } from "./themes";
import { openSourceWithSelection, triggerNativeAi, addSelectionToChat } from "./ai/aiBridge";
import { aiLog } from "./ai/aiLog";
import { clampOffsetRange } from "../shared/ranges";
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

// Readable column width (rem) → drives --file-line-width. Bigger = smaller side
// margins. Clamped to a sane range; falls back to the default.
const DEFAULT_LINE_WIDTH = 75;
function readLineWidth(): number {
  const n = vscode.workspace.getConfiguration("ofm").get<number>("lineWidth");
  return typeof n === "number" && n >= 20 && n <= 240 ? n : DEFAULT_LINE_WIDTH;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDocChanges(
  contentChanges: readonly vscode.TextDocumentContentChangeEvent[]
): DocChange[] {
  return contentChanges.map((c) => ({
    from: c.rangeOffset,
    to: c.rangeOffset + c.rangeLength,
    insert: c.text,
  }));
}

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
  private panels: Map<
    string,
    { document: vscode.TextDocument; panel: vscode.WebviewPanel }
  > = new Map();

  /** Serializes webview edits per URI — the concurrent-edit corruption guard. */
  private editQueue = new SerialQueue();

  /** Last image-map JSON sent per URI, to avoid redundant webview re-renders. */
  private lastImageMap: Map<string, string> = new Map();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly syncManager: DocumentSyncManager,
    private readonly vault?: VaultIndexService,
    private readonly imageIndex?: ImageIndexService
  ) {
    // Global listener: reconcile external document changes into webviews.
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) =>
        this.onDocumentChanged(e)
      )
    );

    // When the image index (re)builds — initial scan finishing, or an attachment
    // added/removed while a note's text is unchanged — recompute the image map
    // for every open editor so newly-resolved images appear without an edit.
    if (this.imageIndex) {
      this.context.subscriptions.push(
        this.imageIndex.onDidChange(() => {
          for (const { document, panel } of this.panels.values()) {
            this.sendImageMap(document, panel);
          }
        })
      );
    }

    // Live theme switching: re-push the active theme to every open editor.
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("ofm.theme")) {
          for (const { panel } of this.panels.values()) {
            const msg: HostMsg = {
              type: "themeChanged",
              theme: this.buildThemePayload(panel.webview),
            };
            panel.webview.postMessage(msg);
          }
        }
        if (e.affectsConfiguration("ofm.lineWidth")) {
          const settings: Settings = { lineWidth: readLineWidth() };
          for (const { panel } of this.panels.values()) {
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
    this.panels.set(uri, { document, panel: webviewPanel });
    webviewPanel.onDidDispose(() => this.panels.delete(uri));

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
    const lineWidth = readLineWidth();

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
    .cm-editor {
      height: 100%;
      outline: none;
    }
    .cm-editor .cm-scroller {
      overflow: auto;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 14px);
      line-height: var(--vscode-editor-line-height, 1.6);
      /* .cm-scroller is a flex row; centering the content here gives balanced
         left/right margins (margin:auto on .cm-content is unreliable in flex). */
      justify-content: center;
    }
    /* Obsidian-like readable, centered column with comfortable margins. The
       column width follows --file-line-width (settable); padding keeps text off
       the edges. Disable centering by setting --ofm-align: flex-start. */
    .cm-editor .cm-scroller { justify-content: var(--ofm-align, center); }
    :root { --file-line-width: ${lineWidth}rem; }
    .cm-content {
      max-width: var(--file-line-width, 46rem);
      width: 100%;
      padding: 2rem 2.5rem 40vh;
      box-sizing: border-box;
    }
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
      case "ready":
        return this.handleReady(document, panel);

      case "edit":
        // Serialize: never apply concurrently (fast typing would race/corrupt).
        this.enqueueEdit(document, msg.changes);
        return;

      case "requestSave":
        await document.save();
        return;

      case "requestUndo":
        await vscode.commands.executeCommand("undo");
        return;

      case "requestRedo":
        await vscode.commands.executeCommand("redo");
        return;

      case "selectionChanged":
        // Slice 1: receive but do nothing (Selection Bridge seat).
        return;

      case "toggleTask":
        return this.handleToggleTask(document, msg.from, msg.to);

      case "openLink":
        // Slice 1: naive file-open by name within workspace.
        return this.handleOpenLink(msg.target);

      case "aiEditSelection":
        aiLog(
          `▶ aiEditSelection received from webview: mode=${msg.mode} from=${msg.from} to=${msg.to}`
        );
        return this.handleAiEditSelection(document, msg.from, msg.to, msg.mode);

      case "log":
        console.log(`[webview:${msg.level}] ${msg.msg}`);
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
    const settings: Settings = { lineWidth: readLineWidth() };
    const theme = this.buildThemePayload(panel.webview);

    const initMsg: HostMsg = {
      type: "init",
      uri: document.uri.toString(),
      version,
      text,
      settings,
      theme,
    };

    panel.webview.postMessage(initMsg);
    this.sendImageMap(document, panel);
  }

  // -----------------------------------------------------------------------
  // Handle edit from webview → minimal-range WorkspaceEdit
  // -----------------------------------------------------------------------

  /**
   * Enqueue a webview edit. Edits MUST apply strictly in order and one at a
   * time: applyEdit is async and fast typing produces many "edit" messages; if
   * applied concurrently, their offsets (computed by the webview against its
   * optimistic-ahead document) race and corrupt/reorder the text. We serialize
   * per-URI via a promise chain.
   */
  private enqueueEdit(document: vscode.TextDocument, changes: DocChange[]): void {
    // Strict per-URI serialization — see SerialQueue. Offsets in `changes` were
    // computed by the webview against its optimistic doc; running edits one at a
    // time means each applies to a document that already contains every prior
    // edit, so they map correctly instead of racing.
    void this.editQueue.run(document.uri.toString(), () =>
      this.applyWebviewEdit(document, changes)
    );
  }

  private async applyWebviewEdit(
    document: vscode.TextDocument,
    changes: DocChange[]
  ): Promise<void> {
    const uri = document.uri.toString();

    // Minimal-range WorkspaceEdit — never a full-document replace. Offsets are
    // resolved against the CURRENT document, which (because we serialize) already
    // contains every prior webview edit, so they map correctly.
    const edit = new vscode.WorkspaceEdit();
    for (const ch of changes) {
      edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(ch.from), document.positionAt(ch.to)),
        ch.insert
      );
    }

    // Mark this URI so the resulting onDidChangeTextDocument is suppressed.
    this.syncManager.markSuppressNext(uri);

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      // No change event will arrive to consume the mark — roll it back so it
      // doesn't leak onto the next genuinely-external change.
      this.syncManager.cancelSuppress(uri);
      console.warn("[ofm] WorkspaceEdit was not applied");
    }
  }

  // -----------------------------------------------------------------------
  // TODO (Slice 2+ hardening, per ADR-0002):
  //   - validate msg.version against document.version before applying; on
  //     mismatch, rebase or fall back to conflict handling instead of
  //     applying at stale offsets.
  //   - external multi-change reconciliation: ensure CM6 receives changes in
  //     original-document coordinates (sorted) to avoid offset drift.

  // -----------------------------------------------------------------------
  // Handle toggleTask — flip [ ] <-> [x] at the marker range
  // -----------------------------------------------------------------------

  private async handleToggleTask(
    document: vscode.TextDocument,
    from: number,
    to: number
  ): Promise<void> {
    const range = new vscode.Range(
      document.positionAt(from),
      document.positionAt(to)
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

  private async handleOpenLink(target: string): Promise<void> {
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

    // Prefer the Vault Index (case-insensitive basename match, alias-aware).
    const viaIndex = this.vault?.resolveLinkUri(target);
    if (viaIndex) {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        viaIndex,
        "ofm.livePreview"
      );
      return;
    }

    // Fallback: naive workspace filename match.
    const files = await vscode.workspace.findFiles(
      `**/${target}.md`,
      undefined,
      1
    );
    if (files.length > 0) {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        files[0],
        "ofm.livePreview"
      );
    } else {
      vscode.window.showInformationMessage(`Could not find note: ${target}`);
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
    // Node 1+2: clamp offsets to the document (selection == source offsets).
    const len = document.getText().length;
    const { from: a, to: bClamped } = clampOffsetRange(from, to, len);
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

  /** Outline navigation: scroll the active Live Preview panel to a 0-based line. */
  public revealLineInActivePanel(line: number): boolean {
    const panel = this.activePanel();
    if (!panel) return false;
    const msg: HostMsg = { type: "revealLine", line };
    void panel.webview.postMessage(msg);
    return true;
  }

  /** The webview panel for the active Live Preview tab (or the sole panel). */
  private activePanel(): vscode.WebviewPanel | undefined {
    const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    let uri: string | undefined;
    if (active instanceof vscode.TabInputCustom && active.viewType === "ofm.livePreview") {
      uri = active.uri.toString();
    }
    const rec =
      (uri ? this.panels.get(uri) : undefined) ??
      (this.panels.size === 1 ? [...this.panels.values()][0] : undefined);
    return rec?.panel;
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

    const uri = document.uri.toString();
    // Stable serialization (sorted keys) so insertion-order churn never reposts;
    // a changed resolved URI for the same key still reposts (index events).
    const json = JSON.stringify(map, Object.keys(map).sort());
    if (this.lastImageMap.get(uri) === json) return; // unchanged → skip
    this.lastImageMap.set(uri, json);
    const msg: HostMsg = { type: "imageMap", map };
    panel.webview.postMessage(msg);
  }

  // -----------------------------------------------------------------------
  // onDidChangeTextDocument → reconcile external changes into webview
  // -----------------------------------------------------------------------

  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    const uri = e.document.uri.toString();
    const panel = this.panels.get(uri)?.panel;

    // Refresh image resolution on every change (images can be typed/edited);
    // sendImageMap only posts when the set of image srcs actually changed.
    if (panel) this.sendImageMap(e.document, panel);

    // Echo suppression: if this change originated from our own webview edit,
    // do NOT send it back (prevents echo loop and cursor jumps).
    if (this.syncManager.shouldSuppress(uri)) {
      return;
    }

    if (!panel) return;

    const changes = toDocChanges(e.contentChanges);

    // If the document was completely replaced (e.g. external reload),
    // use replaceAll to avoid cascading incremental changes.
    if (changes.length === 1 && changes[0].from === 0) {
      const text = e.document.getText();
      // Heuristic: if the replace covers most of the document, treat as replaceAll.
      if (changes[0].to >= text.length || changes[0].insert === text) {
        const replaceAllMsg: HostMsg = {
          type: "replaceAll",
          version: e.document.version,
          text,
        };
        panel.webview.postMessage(replaceAllMsg);
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
    panel.webview.postMessage(applyMsg);
  }
}

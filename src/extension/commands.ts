import * as vscode from "vscode";
import { BUNDLED_THEMES } from "./themes";
import { acceptNativeAi } from "./ai/aiBridge";
import { showAiLog, aiLogForce } from "./ai/aiLog";
import { selectHostAdapter } from "./ai/hostAdapters";
import {
  isAutoSourceRevealSuppressed,
  suppressAutoSourceReveal,
} from "./sourceRevealBridge";

const VIEW_TYPE = "ofm.livePreview";
const PROMPTED_KEY = "ofm.promptedDefaultEditor";
const MD_GLOBS = ["*.md", "*.markdown"];
const lastSourceSelections = new Map<string, { from: number; to: number }>();
const recentSourceActivations = new Map<string, number>();
const recentLiveTabs = new Map<string, number>();
const pendingSourceRevealTimers = new Map<string, ReturnType<typeof setTimeout>>();
const AUTO_SOURCE_REVEAL_WINDOW_MS = 1500;
const RECENT_LIVE_WINDOW_MS = 15000;

/** Minimal surface the AI command needs from the editor provider. */
export interface AiPanelHost {
  requestAiEditOnActivePanel(mode: "edit" | "chat"): boolean;
  openLivePreviewAtOffsets?(
    uri: vscode.Uri,
    range: { from: number; to: number }
  ): Promise<void>;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  aiHost?: AiPanelHost
): void {
  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!isMarkdownUri(e.textEditor.document.uri)) return;
      lastSourceSelections.set(
        e.textEditor.document.uri.toString(),
        selectionOffsets(e.textEditor)
      );
      scheduleAutoSourceReveal(e.textEditor, aiHost);
    })
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      rememberActiveLiveTab();
      if (!editor || !isMarkdownUri(editor.document.uri)) return;
      recentSourceActivations.set(editor.document.uri.toString(), Date.now());
      scheduleAutoSourceReveal(editor, aiHost);
    }),
    vscode.window.tabGroups.onDidChangeTabs(() => rememberActiveLiveTab()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => rememberActiveLiveTab())
  );
  rememberActiveLiveTab();

  reg("ofm.setAsDefaultEditor", () => setAsDefaultEditor());

  reg("ofm.openAsLivePreview", async () => {
    const uri = activeTextUri() ?? activeCustomUri();
    if (uri) await openLivePreview(uri, aiHost);
  });

  reg("ofm.openAsSource", async () => {
    const uri = activeCustomUri() ?? activeTextUri();
    if (uri) {
      suppressAutoSourceReveal(uri);
      await vscode.commands.executeCommand("vscode.openWith", uri, "default");
    }
  });

  reg("ofm.selectTheme", () => selectTheme());

  reg("ofm.showAiLog", () => showAiLog());

  // Debug: report which HostAdapter is detected for the running IDE + the
  // commands it would use, then dump the host's AI/chat command namespace — for
  // diagnosing a new/changed host and choosing an `ofm.ai.*Command` override.
  reg("ofm.dumpAiCommands", async () => {
    const all = await vscode.commands.getCommands(true);
    const ctx = { available: new Set(all), appName: vscode.env.appName };
    const adapter = selectHostAdapter(ctx);
    aiLogForce(`──── host detection ────`);
    aiLogForce(`  appName: ${JSON.stringify(ctx.appName)}`);
    aiLogForce(`  adapter: ${adapter.id}`);
    aiLogForce(`  chat → ${adapter.chat(ctx)?.command ?? "(none)"}`);
    aiLogForce(`  edit → ${adapter.edit(ctx)?.command ?? "(none)"}`);
    aiLogForce(`  accept → ${adapter.accept(ctx) ?? "(none)"}`);
    const re =
      /(ai|chat|cascade|gemini|composer|prompt|generat|inline|windsurf|codeium|exafunction|antigravity|copilot|assistant|llm|agent|ask)/i;
    const hits = all.filter((c) => re.test(c)).sort();
    aiLogForce(`──── AI/chat command namespace (${hits.length} of ${all.length}) ────`);
    for (const c of hits) aiLogForce("  " + c);
    showAiLog();
  });

  // AI Selection Bridge ---------------------------------------------------
  reg("ofm.editSelectionWithAI", () => {
    if (!aiHost?.requestAiEditOnActivePanel("edit")) {
      vscode.window.showInformationMessage(
        "Flintmark: open a Markdown file in Live Preview first."
      );
    }
  });

  reg("ofm.addSelectionToChat", () => {
    if (!aiHost?.requestAiEditOnActivePanel("chat")) {
      vscode.window.showInformationMessage(
        "Flintmark: open a Markdown file in Live Preview first."
      );
    }
  });

  reg("ofm.returnToLivePreview", async () => {
    const uri = activeTextUri() ?? activeCustomUri();
    if (uri) await openLivePreview(uri, aiHost);
  });

  reg("ofm.acceptAiAndReturn", async () => {
    const uri = activeTextUri() ?? activeCustomUri();
    const range = uri ? activeSourceSelectionOffsets(uri) : undefined;
    await acceptNativeAi(); // best-effort; no-op if the host has no accept cmd
    if (uri) await openLivePreview(uri, aiHost, range);
  });

  // First-run: offer to make Live Preview the default for Markdown.
  void maybePromptDefault(context);
}

function activeTextUri(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document.uri ?? activeTabTextUri();
}

function activeCustomUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE) {
    return input.uri;
  }
  return undefined;
}

function activeTabTextUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText) return input.uri;
  return undefined;
}

function rememberActiveLiveTab(): void {
  const uri = activeCustomUri();
  if (uri) recentLiveTabs.set(uri.toString(), Date.now());
}

async function openLivePreview(
  uri: vscode.Uri,
  host?: AiPanelHost,
  range = activeSourceSelectionOffsets(uri)
): Promise<void> {
  if (range && host?.openLivePreviewAtOffsets) {
    await host.openLivePreviewAtOffsets(uri, range);
    return;
  }
  await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
}

function activeSourceSelectionOffsets(
  uri: vscode.Uri
): { from: number; to: number } | undefined {
  const editor = vscode.window.activeTextEditor;
  const key = uri.toString();
  if (!editor || editor.document.uri.toString() !== key) {
    return lastSourceSelections.get(key);
  }
  return selectionOffsets(editor);
}

function selectionOffsets(editor: vscode.TextEditor): { from: number; to: number } {
  return {
    from: editor.document.offsetAt(editor.selection.start),
    to: editor.document.offsetAt(editor.selection.end),
  };
}

function scheduleAutoSourceReveal(
  editor: vscode.TextEditor,
  host?: AiPanelHost
): void {
  if (!host?.openLivePreviewAtOffsets) return;
  if (!isMarkdownUri(editor.document.uri)) return;
  if (
    vscode.workspace
      .getConfiguration("ofm")
      .get<boolean>("globalSearchBridge", true) === false
  ) {
    return;
  }
  const key = editor.document.uri.toString();
  const sourceActivatedAt = recentSourceActivations.get(key) ?? 0;
  if (Date.now() - sourceActivatedAt > AUTO_SOURCE_REVEAL_WINDOW_MS) return;
  if (!hasRecentLivePreviewContext(editor.document.uri)) return;

  const existing = pendingSourceRevealTimers.get(key);
  if (existing) clearTimeout(existing);
  pendingSourceRevealTimers.set(
    key,
    setTimeout(() => {
      pendingSourceRevealTimers.delete(key);
      void autoRevealSourceSelection(editor, host);
    }, 120)
  );
}

async function autoRevealSourceSelection(
  editor: vscode.TextEditor,
  host: AiPanelHost
): Promise<void> {
  const uri = editor.document.uri;
  if (vscode.window.activeTextEditor !== editor) return;
  if (isAutoSourceRevealSuppressed(uri)) return;
  if (!hasRecentLivePreviewContext(uri)) return;
  if (editor.selection.isEmpty) return;
  await host.openLivePreviewAtOffsets?.(uri, selectionOffsets(editor));
}

function hasRecentLivePreviewContext(uri: vscode.Uri): boolean {
  const key = uri.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        input instanceof vscode.TabInputCustom &&
        input.viewType === VIEW_TYPE &&
        input.uri.toString() === key
      ) {
        return true;
      }
    }
  }
  return Date.now() - (recentLiveTabs.get(key) ?? 0) <= RECENT_LIVE_WINDOW_MS;
}

function isMarkdownUri(uri: vscode.Uri): boolean {
  return /\.(md|markdown)$/i.test(uri.path);
}

async function selectTheme(): Promise<void> {
  const current = vscode.workspace.getConfiguration("ofm").get<string>("theme");
  const pick = await vscode.window.showQuickPick(
    BUNDLED_THEMES.map((t) => ({
      label: t.name,
      description: t.id === current ? "(current)" : "",
      id: t.id,
    })),
    { placeHolder: "Select the Live Preview theme" }
  );
  if (pick) {
    await vscode.workspace
      .getConfiguration("ofm")
      .update("theme", pick.id, vscode.ConfigurationTarget.Global);
  }
}

async function setAsDefaultEditor(): Promise<void> {
  const config = vscode.workspace.getConfiguration();
  const assoc = {
    ...(config.get<Record<string, string>>("workbench.editorAssociations") ?? {}),
  };
  for (const glob of MD_GLOBS) assoc[glob] = VIEW_TYPE;
  await config.update(
    "workbench.editorAssociations",
    assoc,
    vscode.ConfigurationTarget.Global
  );
  vscode.window.showInformationMessage(
    "Markdown files now open in Live Preview by default."
  );
}

function isDefaultForMarkdown(): boolean {
  const assoc =
    vscode.workspace
      .getConfiguration()
      .get<Record<string, string>>("workbench.editorAssociations") ?? {};
  return assoc["*.md"] === VIEW_TYPE;
}

async function maybePromptDefault(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get(PROMPTED_KEY)) return;
  if (isDefaultForMarkdown()) {
    await context.globalState.update(PROMPTED_KEY, true);
    return;
  }
  const choice = await vscode.window.showInformationMessage(
    "Open Markdown files in Live Preview by default? (You can always use “Reopen Editor With…”.)",
    "Set as default",
    "Not now"
  );
  await context.globalState.update(PROMPTED_KEY, true);
  if (choice === "Set as default") await setAsDefaultEditor();
}

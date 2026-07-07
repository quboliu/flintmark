import * as vscode from "vscode";
import { BUNDLED_THEMES } from "./themes";
import { acceptNativeAi } from "./ai/aiBridge";
import { showAiLog, aiLogForce } from "./ai/aiLog";
import { selectHostAdapter } from "./ai/hostAdapters";

const VIEW_TYPE = "ofm.livePreview";
const PROMPTED_KEY = "ofm.promptedDefaultEditor";
const MD_GLOBS = ["*.md", "*.markdown"];

/** Minimal surface the AI command needs from the editor provider. */
export interface AiPanelHost {
  requestAiEditOnActivePanel(mode: "edit" | "chat"): boolean;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  aiHost?: AiPanelHost
): void {
  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("ofm.setAsDefaultEditor", () => setAsDefaultEditor());

  reg("ofm.openAsLivePreview", async () => {
    const uri = activeTextUri() ?? activeCustomUri();
    if (uri) await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
  });

  reg("ofm.openAsSource", async () => {
    const uri = activeCustomUri() ?? activeTextUri();
    if (uri) await vscode.commands.executeCommand("vscode.openWith", uri, "default");
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
    if (uri) await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
  });

  reg("ofm.acceptAiAndReturn", async () => {
    const uri = activeTextUri() ?? activeCustomUri();
    await acceptNativeAi(); // best-effort; no-op if the host has no accept cmd
    if (uri) await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
  });

  // First-run: offer to make Live Preview the default for Markdown.
  void maybePromptDefault(context);
}

function activeTextUri(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document.uri;
}

function activeCustomUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE) {
    return input.uri;
  }
  return undefined;
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

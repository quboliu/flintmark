import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// AI Selection Bridge.
//
// We do NOT build our own AI. A webview-based custom editor hides its selection
// from the host (`window.activeTextEditor` is undefined when our editor is
// focused), so the host's native AI cannot see what's selected in Live Preview.
// The bridge fixes this WITHOUT any AI logic of our own:
//   (1) relocate the selection into the REAL source text editor, then
//   (2) hand off to the host's native AI command — chosen by the per-IDE
//       HostAdapter (see hostAdapters.ts), NOT a flat command list.
// On any failure it degrades to a status-bar hint, leaving the user in source
// with the selection set, ready to invoke their AI manually.
// ---------------------------------------------------------------------------

import { selectHostAdapter, type HostContext } from "./hostAdapters";
import { aiLog } from "./aiLog";

const MANUAL_HINT = "Flintmark: selection is ready in source — invoke your AI (e.g. ⌘K / Ctrl+K).";

function hint(message: string): void {
  vscode.window.setStatusBarMessage(message, 6000);
}

/** Snapshot of the running host for the pure adapter layer. */
async function hostContext(): Promise<HostContext> {
  return {
    available: new Set(await vscode.commands.getCommands(true)),
    appName: vscode.env.appName,
  };
}

/**
 * Relocate to the real source editor with the selection set.
 * Ideal: replace the custom-editor tab in place (`vscode.openWith … default`).
 * Fallbacks: showTextDocument (beside layout, or if the in-place flip fails).
 */
export async function openSourceWithSelection(
  document: vscode.TextDocument,
  selection: vscode.Selection,
  layout: "replace" | "beside"
): Promise<vscode.TextEditor | null> {
  const uriStr = document.uri.toString();
  aiLog(`openSource: layout=${layout} uri=${document.uri.fsPath}`);
  if (layout === "replace") {
    try {
      await vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
      aiLog("openSource: openWith(default) OK — flipped tab to source");
    } catch (e) {
      aiLog(`openSource: openWith(default) failed (${(e as Error)?.message}) — using showTextDocument`);
    }
  }
  let editor: vscode.TextEditor | undefined;
  try {
    editor = await vscode.window.showTextDocument(document, {
      preview: false,
      viewColumn: layout === "beside" ? vscode.ViewColumn.Beside : undefined,
    });
  } catch (e) {
    aiLog(`openSource: showTextDocument threw (${(e as Error)?.message}) — searching visible editors`);
    editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === uriStr
    );
  }
  if (editor) {
    editor.selection = selection;
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    aiLog(
      `openSource: source editor READY, selection set [${selection.start.line}:${selection.start.character}..${selection.end.line}:${selection.end.character}]`
    );
  } else {
    aiLog("openSource: FAILED — no source editor (host couldn't open the document)");
  }
  return editor ?? null;
}

/**
 * Hand off to the host's native inline AI (the active HostAdapter decides which
 * command). On "manual" mode / no command / failure → status-bar hint.
 */
export async function triggerNativeAi(
  mode: "auto" | "manual",
  preferredCommand?: string
): Promise<void> {
  if (mode === "manual") {
    aiLog("trigger(edit): manual mode → status-bar hint only (no command fired)");
    hint(MANUAL_HINT);
    return;
  }
  const ctx = await hostContext();
  const adapter = selectHostAdapter(ctx);
  const plan = adapter.edit(ctx, preferredCommand);
  aiLog(`trigger(edit): host=${adapter.id} appName=${JSON.stringify(ctx.appName ?? "")}`);
  if (!plan) {
    aiLog(`trigger(edit): host '${adapter.id}' has no inline-AI command → manual hint`);
    hint(MANUAL_HINT);
    return;
  }
  aiLog(`trigger(edit): invoking '${plan.command}'`);
  try {
    await vscode.commands.executeCommand(plan.command);
    aiLog(`trigger(edit): '${plan.command}' returned OK`);
  } catch (e) {
    aiLog(`trigger(edit): '${plan.command}' THREW: ${(e as Error)?.message} → manual hint`);
    hint(MANUAL_HINT);
  }
}

/**
 * "Add to Chat" — attach the (now relocated to source) selection to the host's
 * native AI chat (the active HostAdapter decides which command). Returns true
 * if a chat command was invoked.
 */
export async function addSelectionToChat(preferredCommand?: string): Promise<boolean> {
  const ctx = await hostContext();
  const adapter = selectHostAdapter(ctx);
  const plan = adapter.chat(ctx, preferredCommand);
  aiLog(`addToChat: host=${adapter.id} appName=${JSON.stringify(ctx.appName ?? "")}`);
  if (!plan) {
    aiLog(`addToChat: host '${adapter.id}' has no chat command → selection left ready in source`);
    hint("Flintmark: no AI chat found — open your chat; the selection is ready in source.");
    return false;
  }
  aiLog(`addToChat: invoking '${plan.command}'`);
  try {
    await vscode.commands.executeCommand(plan.command);
    aiLog(`addToChat: '${plan.command}' returned OK`);
    return true;
  } catch (e) {
    aiLog(`addToChat: '${plan.command}' THREW: ${(e as Error)?.message} → selection left ready in source`);
    hint("Flintmark: couldn't add to chat — the selection is ready in source.");
    return false;
  }
}

/** Best-effort accept (if the active host adapter knows an accept command). */
export async function acceptNativeAi(): Promise<boolean> {
  const ctx = await hostContext();
  const accept = selectHostAdapter(ctx).accept(ctx);
  if (!accept) return false;
  try {
    await vscode.commands.executeCommand(accept);
    return true;
  } catch {
    return false;
  }
}

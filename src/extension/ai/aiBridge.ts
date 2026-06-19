import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// AI Selection Bridge.
//
// We do NOT build our own AI. A webview-based custom editor hides its selection
// from the host (`window.activeTextEditor` is undefined when our editor is
// focused), so the host's native AI (Copilot inline chat, Cursor Cmd+K) cannot
// see what's selected in Live Preview. The bridge fixes this WITHOUT any AI
// logic of our own: it relocates the selection into the REAL source text editor
// and then hands off entirely to whatever native AI the host provides.
//
// Command IDs below were confirmed by probing the real hosts:
//   VS Code 1.124 / VSCodium : inlineChat.start ✓        (aipopup.* absent)
//   Cursor 3.2.11            : aipopup.action.modal.generate ✓ (inlineChat.start absent)
// Each node has a fallback so the worst case still leaves the user in source
// with the selection set, ready to invoke their AI manually.
// ---------------------------------------------------------------------------

import {
  pickAiTrigger,
  pickAiAccept,
  pickChatTrigger,
  type AiTriggerKind,
} from "./aiCommands";
import { aiLog } from "./aiLog";

const MANUAL_HINT = "Flintmark: selection is ready in source — invoke your AI (e.g. ⌘K / Ctrl+K).";

/**
 * Node 3 — relocate to the real source editor with the selection set.
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
 * Node 4 — hand off to the host's native AI. Detects the available command and
 * invokes it; on any failure (or "manual" mode / no AI present) it degrades to
 * a status-bar hint, leaving the user in source with the selection ready.
 */
export async function triggerNativeAi(
  mode: "auto" | "manual",
  preferredCommand?: string
): Promise<AiTriggerKind> {
  if (mode === "manual") {
    aiLog("trigger(edit): manual mode → status-bar hint only (no command fired)");
    vscode.window.setStatusBarMessage(MANUAL_HINT, 6000);
    return "manual";
  }
  const available = new Set(await vscode.commands.getCommands(true));
  const pick = pickAiTrigger(available, preferredCommand);
  if (!pick) {
    aiLog(
      `trigger(edit): NO inline-AI command available (preferred=${preferredCommand ?? "—"}) → manual hint`
    );
    vscode.window.setStatusBarMessage(MANUAL_HINT, 6000);
    return "manual";
  }
  aiLog(`trigger(edit): invoking '${pick.command}' (kind=${pick.kind})`);
  try {
    await vscode.commands.executeCommand(pick.command);
    aiLog(`trigger(edit): '${pick.command}' returned OK`);
    return pick.kind;
  } catch (e) {
    aiLog(`trigger(edit): '${pick.command}' THREW: ${(e as Error)?.message} → manual hint`);
    vscode.window.setStatusBarMessage(MANUAL_HINT, 6000);
    return "manual";
  }
}

/**
 * "Add to Chat" — attach the (now relocated to source) selection to the host's
 * native AI chat/composer. Returns true if a chat command was invoked.
 */
export async function addSelectionToChat(preferredCommand?: string): Promise<boolean> {
  const available = new Set(await vscode.commands.getCommands(true));
  const cmd = pickChatTrigger(available, preferredCommand);
  if (!cmd) {
    aiLog(
      `addToChat: NO chat command available (preferred=${preferredCommand ?? "—"}) → selection left ready in source`
    );
    vscode.window.setStatusBarMessage(
      "Flintmark: no AI chat found — open your chat and the selection is ready in source.",
      6000
    );
    return false;
  }
  aiLog(`addToChat: invoking '${cmd}'`);
  try {
    await vscode.commands.executeCommand(cmd);
    aiLog(`addToChat: '${cmd}' returned OK`);
    return true;
  } catch (e) {
    aiLog(`addToChat: '${cmd}' THREW: ${(e as Error)?.message} → selection left ready in source`);
    vscode.window.setStatusBarMessage(
      "Flintmark: couldn't add to chat — the selection is ready in source.",
      6000
    );
    return false;
  }
}

/** Node 5 — best-effort accept (if the host exposes an accept command). */
export async function acceptNativeAi(): Promise<boolean> {
  const available = new Set(await vscode.commands.getCommands(true));
  const accept = pickAiAccept(available);
  if (!accept) return false;
  try {
    await vscode.commands.executeCommand(accept);
    return true;
  } catch {
    return false;
  }
}

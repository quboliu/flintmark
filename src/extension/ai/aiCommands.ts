// Pure AI command-selection logic (NO vscode import) so it is unit-testable in
// Node. aiBridge.ts uses these to drive the host's native AI.
//
// Command IDs confirmed by probing the real hosts:
//   VS Code 1.124 / VSCodium : inlineChat.start ✓        (aipopup.* absent)
//   Cursor 3.2.11            : aipopup.action.modal.generate ✓ (inlineChat.start absent)

export type AiTriggerKind = "inline" | "chat" | "manual";

/** Ordered trigger candidates: [commandId, kind]. First one the host actually
 *  registers wins. Host-exclusive, so order only matters for the chat fallback. */
export const AI_TRIGGER_CANDIDATES: ReadonlyArray<readonly [string, AiTriggerKind]> = [
  ["aipopup.action.modal.generate", "inline"], // Cursor — Cmd+K inline generate
  ["inlineChat.start", "inline"], // VS Code / Copilot — inline chat
  ["workbench.action.chat.open", "chat"], // VS Code — chat view (fallback)
  ["composer.addfilestocomposer", "chat"], // Cursor — Composer (fallback)
  ["aichat.newchataction", "chat"], // Cursor — chat (fallback)
];

/** "Add the selection to the AI chat" candidates (probed on real hosts).
 *  VS Code/Copilot: attachSelection; Cursor: addToChatAction / aichat.newchataction.
 *  First available wins; last resort just opens the chat panel. */
export const ADD_TO_CHAT_CANDIDATES: readonly string[] = [
  "workbench.action.chat.attachSelection", // VS Code/Copilot — attach selection as context
  "composer.startComposerPromptFromSelection", // Cursor — selection → composer (the Ctrl+L action)
  "aichat.newchataction", // Cursor — new chat (includes the selection)
  "workbench.action.chat.addToChatAction", // generic add-to-chat
  "glass.insertSelectionIntoGlassComposer", // Cursor "Glass" window mode (rarely the main chat)
  "workbench.action.chat.open", // last resort — just open the chat panel
];

/** Pick the first available "add to chat" command (honoring an override). */
export function pickChatTrigger(
  available: ReadonlySet<string>,
  preferred?: string
): string | null {
  if (preferred && preferred.length > 0 && available.has(preferred)) return preferred;
  for (const c of ADD_TO_CHAT_CANDIDATES) if (available.has(c)) return c;
  return null;
}

/** Best-effort "accept the AI edit" commands, for the Accept-&-return command. */
export const AI_ACCEPT_CANDIDATES: readonly string[] = [
  "inlineChat.acceptChanges",
  "composer.acceptComposerStep",
  "composer.acceptPlan",
  "aipopup.action.insertEditSelection",
  "editor.action.inlineSuggest.commit",
];

/** Pick the first available trigger (honoring an explicit override). */
export function pickAiTrigger(
  available: ReadonlySet<string>,
  preferred?: string
): { command: string; kind: AiTriggerKind } | null {
  if (preferred && preferred.length > 0 && available.has(preferred)) {
    const known = AI_TRIGGER_CANDIDATES.find(([c]) => c === preferred);
    return { command: preferred, kind: known ? known[1] : "inline" };
  }
  for (const [command, kind] of AI_TRIGGER_CANDIDATES) {
    if (available.has(command)) return { command, kind };
  }
  return null;
}

/** Pick the first available "accept" command. */
export function pickAiAccept(available: ReadonlySet<string>): string | null {
  for (const c of AI_ACCEPT_CANDIDATES) if (available.has(c)) return c;
  return null;
}

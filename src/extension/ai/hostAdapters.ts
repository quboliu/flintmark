// Host (IDE) adaptation layer — pure, NO vscode import, so it is unit-testable
// in Node (ADR-0005: host-independent kernel).
//
// Problem: the host's native AI is reached through DIFFERENT commands per IDE,
// and each IDE follows a different paradigm:
//   - VS Code / Copilot : `workbench.action.chat.*`, `inlineChat.start`
//   - Cursor            : `aichat.*`, `aipopup.*`, `composer.*`
//   - Antigravity       : `antigravity.*` "Agent" (Windsurf/Codeium-derived) —
//                         e.g. `antigravity.toggleChatFocus` attaches the
//                         selection as a chip, NO VS Code chat involved.
// A flat "first command that exists wins" list couples all hosts together and
// breaks the moment one host also exposes another host's (inert) command.
//
// Design: STRATEGY + REGISTRY. Each IDE is one HostAdapter that (a) detects
// whether it is the active host (`matches`) and (b) maps an intent
// (chat / edit / accept) to that host's command — keeping each host's quirks
// isolated. `selectHostAdapter` picks the most-specific matching adapter at
// runtime. Adding an IDE = add one adapter; an IDE changing a command across
// versions = edit that one adapter's candidate list (with fallbacks), or the
// user sets an `ofm.ai.*Command` override (honored by every adapter).

export type AiTriggerKind = "inline" | "chat";

/** What the pure layer knows about the running host. */
export interface HostContext {
  /** Command IDs the host has registered (`vscode.commands.getCommands(true)`). */
  available: ReadonlySet<string>;
  /** `vscode.env.appName`, e.g. "Cursor", "Antigravity IDE", "VSCodium". */
  appName?: string;
}

/** A resolved command to run for an intent. */
export interface CommandPlan {
  command: string;
  kind: AiTriggerKind;
}

/** One IDE's strategy. */
export interface HostAdapter {
  readonly id: string;
  /** Is this the active host? Checked most-specific first. */
  matches(ctx: HostContext): boolean;
  /** "Add selection to chat" command for this host (or null if none usable). */
  chat(ctx: HostContext, override?: string): CommandPlan | null;
  /** Inline "edit selection with AI" command (or null). */
  edit(ctx: HostContext, override?: string): CommandPlan | null;
  /** Best-effort "accept the AI edit" command (or null). */
  accept(ctx: HostContext): string | null;
}

// --- helpers --------------------------------------------------------------

/** First usable command: an explicit override wins, else the first candidate
 *  the host actually registers. Keeps per-host fallbacks for version drift. */
function pick(
  available: ReadonlySet<string>,
  candidates: readonly string[],
  override?: string
): string | null {
  if (override && override.length > 0 && available.has(override)) return override;
  for (const c of candidates) if (available.has(c)) return c;
  return null;
}

const hasAny = (set: ReadonlySet<string>, ids: readonly string[]): boolean =>
  ids.some((id) => set.has(id));

const appIs = (ctx: HostContext, needle: string): boolean =>
  !!ctx.appName && ctx.appName.toLowerCase().includes(needle);

interface AdapterSpec {
  id: string;
  matches: (ctx: HostContext) => boolean;
  chatCmds: readonly string[];
  editCmds: readonly string[];
  acceptCmds: readonly string[];
}

function defineAdapter(spec: AdapterSpec): HostAdapter {
  return {
    id: spec.id,
    matches: spec.matches,
    chat: (ctx, override) => {
      const c = pick(ctx.available, spec.chatCmds, override);
      return c ? { command: c, kind: "chat" } : null;
    },
    edit: (ctx, override) => {
      const c = pick(ctx.available, spec.editCmds, override);
      return c ? { command: c, kind: "inline" } : null;
    },
    accept: (ctx) => pick(ctx.available, spec.acceptCmds),
  };
}

// --- adapters (most-specific first) ---------------------------------------

/** Antigravity IDE (Google; Windsurf/Codeium-derived). VERIFIED: Ctrl+L
 *  `antigravity.toggleChatFocus` focuses chat + attaches the selection as a
 *  deletable #Lx-y chip, no auto-send. It is also a VS Code fork (has
 *  inlineChat.start etc.), so it MUST be detected before the VS Code adapter. */
const antigravityAdapter = defineAdapter({
  id: "antigravity",
  matches: (ctx) =>
    appIs(ctx, "antigravity") ||
    hasAny(ctx.available, [
      "antigravity.toggleChatFocus",
      "antigravity.openAgent",
      "antigravity.openInteractiveEditor",
    ]),
  chatCmds: ["antigravity.toggleChatFocus"],
  editCmds: ["antigravity.openInteractiveEditor"],
  acceptCmds: [
    "antigravity.prioritized.agentAcceptFocusedHunk",
    "antigravity.prioritized.agentAcceptAllInFile",
  ],
});

/** Cursor. */
const cursorAdapter = defineAdapter({
  id: "cursor",
  matches: (ctx) =>
    appIs(ctx, "cursor") ||
    hasAny(ctx.available, ["aipopup.action.modal.generate", "aichat.newchataction"]),
  chatCmds: [
    "aichat.newchataction",
    "composer.startComposerPromptFromSelection",
    "glass.insertSelectionIntoGlassComposer",
  ],
  editCmds: ["aipopup.action.modal.generate"],
  acceptCmds: [
    "aipopup.action.insertEditSelection",
    "composer.acceptComposerStep",
    "composer.acceptPlan",
  ],
});

/** VS Code / Copilot / VSCodium (the base VS Code chat paradigm). */
const vscodeAdapter = defineAdapter({
  id: "vscode",
  matches: (ctx) =>
    appIs(ctx, "visual studio code") ||
    hasAny(ctx.available, ["workbench.action.chat.attachSelection", "inlineChat.start"]),
  chatCmds: [
    "workbench.action.chat.attachSelection",
    "workbench.action.chat.addToChatAction",
    "workbench.action.chat.open",
  ],
  editCmds: ["inlineChat.start"],
  acceptCmds: ["inlineChat.acceptChanges", "editor.action.inlineSuggest.commit"],
});

/** Fallback — matches anything; tries the generic VS Code chat surface. */
const genericAdapter = defineAdapter({
  id: "generic",
  matches: () => true,
  chatCmds: [
    "workbench.action.chat.attachSelection",
    "workbench.action.chat.addToChatAction",
    "workbench.action.chat.open",
  ],
  editCmds: ["inlineChat.start", "aipopup.action.modal.generate"],
  acceptCmds: ["editor.action.inlineSuggest.commit"],
});

/** Registry, most-specific first. genericAdapter is the always-match backstop. */
export const HOST_ADAPTERS: readonly HostAdapter[] = [
  antigravityAdapter,
  cursorAdapter,
  vscodeAdapter,
  genericAdapter,
];

/** Pick the active host's adapter (the first whose `matches` is true). */
export function selectHostAdapter(ctx: HostContext): HostAdapter {
  return HOST_ADAPTERS.find((a) => a.matches(ctx)) ?? genericAdapter;
}

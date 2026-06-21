// Entry point for the webview bundle.
// Follows docs/03-solution-design.md: receives init from host, creates CM6,
// sends minimal-range edits, applies host-originated deltas without echo.

import "katex/dist/katex.min.css";
import "./theme/obsidian-variables.css";
import "./theme/obsidian-base.css";
import { EditorView } from "@codemirror/view";
import type {
  DocVersion,
  HostMsg,
  WebviewMsg,
  DocChange,
  ThemePayload,
  Settings,
  VaultData,
} from "../shared/protocol";
import { settingsToCssVars } from "../shared/settings";
import { createMessenger } from "./messaging/client";
import { createEditor, hostOrigin, currentSelectionRange } from "./view/createEditor";
import { setImageMap } from "./view/widgets/imageWidget";
import { applyAttachmentSaved } from "./view/attachmentPaste";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const messenger = createMessenger();
let view: EditorView | null = null;
let currentVersion: DocVersion = 0;
let vaultData: VaultData = { notes: [], tags: [] };

// ---------------------------------------------------------------------------
// Register message handler
// ---------------------------------------------------------------------------

messenger.onMessage((msg: HostMsg) => {
  switch (msg.type) {
    case "init":
      handleInit(msg);
      break;
    case "applyEdit":
      handleApplyEdit(msg.version, msg.changes);
      break;
    case "replaceAll":
      handleReplaceAll(msg.version, msg.text);
      break;
    case "settingsChanged":
      applySettings(msg.settings);
      break;
    case "themeChanged":
      applyTheme(msg.theme);
      break;
    case "vaultData":
      vaultData = msg.vault;
      break;
    case "attachmentSaved":
      if (view) applyAttachmentSaved(view, msg.requestId, msg.embed);
      break;
    case "imageMap":
      if (view) view.dispatch({ effects: setImageMap.of(msg.map) });
      break;
    case "requestAiEdit":
      // Palette/command path: report the current selection so the host can
      // run the AI Selection Bridge (in the requested mode).
      if (view) {
        const r = currentSelectionRange(view);
        messenger.post({ type: "aiEditSelection", from: r.from, to: r.to, mode: msg.mode });
      }
      break;
    case "revealLine":
      handleRevealLine(msg.line);
      break;
    case "conflict":
      handleConflict(msg.serverVersion);
      break;
  }
});

// ---------------------------------------------------------------------------
// init: create CM6 editor with the document text
// ---------------------------------------------------------------------------

function handleInit(msg: Extract<HostMsg, { type: "init" }>): void {
  currentVersion = msg.version;
  if (msg.vault) vaultData = msg.vault;

  if (view) {
    view.destroy();
  }

  const parent = document.getElementById("editor");
  if (!parent) {
    console.error("[ofm] #editor element not found");
    return;
  }

  // The editing surface is the `.ml-root` (CONTEXT.md), carrying the Obsidian
  // DOM classes that themes target (Obsidian's Live Preview is also CM6, so the
  // .cm-* classes already match). Follow VS Code dark/light.
  parent.classList.add(
    "ml-root",
    "markdown-source-view",
    "mod-cm6",
    "is-live-preview",
    "markdown-rendered",
    "cm-s-obsidian" // CM5-era theme scope: Things' .cm-* token + codeblock rules live under it
  );
  const dark =
    document.body.classList.contains("vscode-dark") ||
    document.body.classList.contains("vscode-high-contrast");
  const mode = dark ? "theme-dark" : "theme-light";
  parent.classList.add(mode);
  document.body.classList.add(mode);
  applyTheme(msg.theme);
  applySettings(msg.settings);

  view = createEditor(parent, msg.text, {
    onUserEdit: (changes: DocChange[]) => {
      messenger.post({
        type: "edit",
        version: currentVersion,
        changes,
      });
    },
    onRequestUndo: () => {
      messenger.post({ type: "requestUndo" });
    },
    onRequestRedo: () => {
      messenger.post({ type: "requestRedo" });
    },
    onToggleTask: (range) => {
      messenger.post({ type: "toggleTask", from: range.from, to: range.to });
    },
    onOpenLink: (target) => {
      messenger.post({ type: "openLink", target });
    },
    onRequestAiEdit: (range) => {
      messenger.post({ type: "aiEditSelection", from: range.from, to: range.to, mode: "edit" });
    },
    onRequestAddToChat: (range) => {
      messenger.post({ type: "aiEditSelection", from: range.from, to: range.to, mode: "chat" });
    },
    getVaultData: () => vaultData,
    onSaveAttachment: (payload) => {
      messenger.post({ type: "saveAttachment", ...payload });
    },
    onNotify: (message) => {
      messenger.post({ type: "warn", message });
    },
  });
}

// ---------------------------------------------------------------------------
// applyEdit: reconcile external deltas into CM6 without re-sending
// ---------------------------------------------------------------------------

function handleApplyEdit(version: DocVersion, changes: DocChange[]): void {
  if (!view) return;

  currentVersion = version;

  view.dispatch({
    changes: changes.map((ch) => ({
      from: ch.from,
      to: ch.to,
      insert: ch.insert,
    })),
    annotations: hostOrigin.of(true),
  });
}

// ---------------------------------------------------------------------------
// replaceAll: full document reload (external change / conflict resolution)
// ---------------------------------------------------------------------------

function handleReplaceAll(version: DocVersion, text: string): void {
  if (!view) return;

  currentVersion = version;

  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    annotations: hostOrigin.of(true),
  });
}

// ---------------------------------------------------------------------------
// conflict: placeholder for future conflict resolution UI
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// revealLine: scroll to and place the cursor at a 0-based line (Outline nav)
// ---------------------------------------------------------------------------

function handleRevealLine(line: number): void {
  if (!view) return;
  const n = Math.max(1, Math.min(line + 1, view.state.doc.lines));
  const pos = view.state.doc.line(n).from;
  view.focus();
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 8 }),
  });
}

function handleConflict(_serverVersion: DocVersion): void {
  console.warn("[ofm] conflict detected — server version:", _serverVersion);
}

// ---------------------------------------------------------------------------
// applyTheme: swap the active theme stylesheet live (no reload). The webview
// doesn't care if the CSS is a bundled theme or a future custom one.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// applySettings: apply layout settings (readable column width → side margins)
// ---------------------------------------------------------------------------

function applySettings(settings: Settings | undefined): void {
  if (!settings) return;
  // Set/remove override variables on the document root. Setting them on :root
  // (highest in the cascade for these vars — the theme never declares them) lets
  // a user font win over both the theme's --font-text-theme and the VS Code
  // editor font; a `null` (cleared setting) removes the var so it reverts.
  const root = document.documentElement.style;
  for (const { name, value } of settingsToCssVars(settings)) {
    if (value === null) root.removeProperty(name);
    else root.setProperty(name, value);
  }
}

function applyTheme(theme: ThemePayload | undefined): void {
  if (!theme) return;
  const existing = document.getElementById("ofm-theme");
  let link: HTMLLinkElement;
  if (existing instanceof HTMLLinkElement) {
    link = existing;
  } else {
    link = document.createElement("link");
    link.id = "ofm-theme";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  if (theme.cssUri) link.href = theme.cssUri;
  else link.removeAttribute("href");
}

// ---------------------------------------------------------------------------
// Signal to the host that the webview is loaded and ready
// ---------------------------------------------------------------------------

messenger.post({ type: "ready" });

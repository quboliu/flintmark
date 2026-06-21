// === Message types for Host ↔ Webview communication ===
// Following docs/03-solution-design.md section 4 exactly.
// Origin + DocVersion on every change message are the foundation of echo suppression (ADR-0002).

/** Identifies which side originated a change. */
export type Origin = "webview" | "host";

/** Monotonically increasing document version, aligned with TextDocument.version. */
export type DocVersion = number;

// ---------------------------------------------------------------------------
// Webview → Host
// ---------------------------------------------------------------------------

export type WebviewMsg =
  | { type: "ready" }
  | { type: "edit"; version: DocVersion; changes: DocChange[] }
  | { type: "selectionChanged"; selection: LiveSelection | null }
  | { type: "requestSave" }
  | { type: "requestUndo" }
  | { type: "requestRedo" }
  | { type: "toggleTask"; from: number; to: number }
  | { type: "openLink"; target: string }
  // AI Selection Bridge: relocate this CM6 selection to the source editor and
  // hand off to the host's native AI. from/to are document offsets (== source
  // offsets, since the doc content is identical to the source). mode picks the
  // handoff: "edit" → inline edit (Cmd+K); "chat" → add selection to chat.
  | { type: "aiEditSelection"; from: number; to: number; mode: "edit" | "chat" }
  // Image paste/drop: send the bytes (base64) to the host, which writes an
  // attachment next to the note and replies with `attachmentSaved` carrying the
  // embed name to insert.
  | {
      type: "saveAttachment";
      requestId: number;
      filename: string;
      mime: string;
      dataBase64: string;
    }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string };

// ---------------------------------------------------------------------------
// Host → Webview
// ---------------------------------------------------------------------------

export type HostMsg =
  | {
      type: "init";
      uri: string;
      version: DocVersion;
      text: string;
      settings: Settings;
      theme: ThemePayload;
      vault?: VaultData;
    }
  | {
      type: "applyEdit";
      version: DocVersion;
      origin: Origin;
      changes: DocChange[];
    }
  | {
      type: "replaceAll";
      version: DocVersion;
      text: string;
    }
  | { type: "settingsChanged"; settings: Settings }
  | { type: "themeChanged"; theme: ThemePayload }
  | { type: "vaultData"; vault: VaultData }
  | { type: "attachmentSaved"; requestId: number; embed: string }
  | { type: "imageMap"; map: Record<string, string> }
  // Palette/command path: ask the webview to report its current selection so the
  // host can run the AI Selection Bridge (the webview replies with aiEditSelection).
  | { type: "requestAiEdit"; mode: "edit" | "chat" }
  // Scroll/place the cursor at a 0-based line (Outline panel navigation).
  | { type: "revealLine"; line: number }
  | { type: "conflict"; serverVersion: DocVersion };

// ---------------------------------------------------------------------------
// Shared substructures
// ---------------------------------------------------------------------------

/** A minimal-range document change: replace text from [from, to) with `insert`. */
export interface DocChange {
  /** Start offset (0-based) in the document before the change. */
  from: number;
  /** End offset (0-based, exclusive) in the document before the change. */
  to: number;
  /** Text to insert at `from`. */
  insert: string;
}

/** A range in the Markdown source text (line/character, not offset). */
export interface SourceRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/** Block types for Selection Bridge (Phase 2 AI). */
export type BlockType =
  | "paragraph"
  | "heading"
  | "callout"
  | "code"
  | "table"
  | "image"
  | "list"
  | "math"
  | "mermaid"
  | "blockquote";

/** User selection state, sent from webview to host for Selection Bridge. */
export interface LiveSelection {
  uri: string;
  version: DocVersion;
  sourceRange: SourceRange;
  selectedMarkdown: string;
  selectedPlainText: string;
  blockType?: BlockType;
  surroundingMarkdown?: string;
}

/** Extension settings pushed to the webview. */
export interface Settings {
  /** Readable column width in rem (drives --file-line-width; smaller side margins
   *  come from a larger value). */
  lineWidth?: number;
  /** Font-family for rendered prose (body text + headings). Omitted = follow the
   *  active theme / VS Code UI font. Independent of the VS Code editor font. */
  fontFamily?: string;
  /** Font-size (px) for rendered prose. Omitted = editor font size + 2px. */
  fontSize?: number;
  /** Font-family for code (fenced blocks, inline code, frontmatter). Omitted =
   *  follow the VS Code editor font. */
  monospaceFontFamily?: string;
}

/** Vault data pushed to the webview for autocomplete (`[[` notes, `#` tags). */
export interface VaultData {
  /** Note basenames (no extension), deduped + sorted — for `[[ ]]` completion. */
  notes: string[];
  /** Tags (without `#`), sorted — for `#` completion. */
  tags: string[];
}

/** Active theme, sent from host to webview. The webview just applies the CSS at
 *  cssUri via a swappable <link> — it doesn't care whether it's bundled or custom. */
export interface ThemePayload {
  /** Active theme id (matches the `ofm.theme` setting). */
  id: string;
  /** Webview URI of the active theme's CSS, or null for the built-in base only. */
  cssUri: string | null;
}

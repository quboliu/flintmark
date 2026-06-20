/*
 * Decoration theme — CSS injected via CM6 theme extension.
 *
 * Colors are driven by Obsidian CSS variables (so the active bundled theme, e.g.
 * Things, re-skins the editor) with VS Code variables as fallback. Sizes/spacing
 * are our defaults. NOTE: Decoration.line() puts the class ON the .cm-line, so
 * the selector is `.cm-line.ofm-heading-N` (same element), not a descendant.
 */

import { EditorView } from "@codemirror/view";

export const markdownTheme = EditorView.theme({
  /* Body text font: follow the theme's text font (Things = system sans), with
     the VS Code UI font as fallback. Code/inline-code/frontmatter set their own
     monospace and so are unaffected.
     Size: a reading/writing surface wants a bit more than the code-editor font,
     so bump 2px above editor.fontSize (default 14 → 16). Headings are rem-based
     and unaffected; code blocks/inline are em-based and ride up with this. */
  ".cm-content": {
    fontFamily: "var(--font-text, var(--vscode-font-family, sans-serif))",
    // --ofm-font-size (set by the webview from `ofm.fontSize`) wins when present;
    // else the editor font size + 2px. Headings (rem) are unaffected; code/inline
    // (em) ride up with this.
    fontSize:
      "var(--ofm-font-size, calc(var(--vscode-editor-font-size, 14px) + 2px))",
  },
  /* Headings (1-6) — size & weight follow the theme (--hN-size/--hN-weight);
     colors come from the theme (--hN-color). Fallbacks preserve our look when a
     theme leaves a var unset. */
  ".cm-line.ofm-heading-1": {
    fontSize: "var(--h1-size, 1.9em)",
    fontWeight: "var(--h1-weight, 700)",
    lineHeight: "1.25",
    paddingTop: "0.5em",
    paddingBottom: "0.2em",
    color: "var(--h1-color, inherit)",
  },
  ".cm-line.ofm-heading-2": {
    fontSize: "var(--h2-size, 1.55em)",
    fontWeight: "var(--h2-weight, 600)",
    lineHeight: "1.3",
    paddingTop: "0.4em",
    paddingBottom: "0.18em",
    color: "var(--h2-color, inherit)",
  },
  ".cm-line.ofm-heading-3": {
    fontSize: "var(--h3-size, 1.3em)",
    fontWeight: "var(--h3-weight, 600)",
    lineHeight: "1.35",
    paddingTop: "0.3em",
    paddingBottom: "0.15em",
    color: "var(--h3-color, inherit)",
  },
  ".cm-line.ofm-heading-4": {
    fontSize: "var(--h4-size, 1.15em)",
    fontWeight: "var(--h4-weight, 600)",
    lineHeight: "1.4",
    color: "var(--h4-color, inherit)",
  },
  ".cm-line.ofm-heading-5": {
    fontSize: "var(--h5-size, 1.05em)",
    fontWeight: "var(--h5-weight, 600)",
    lineHeight: "1.5",
    color: "var(--h5-color, inherit)",
  },
  ".cm-line.ofm-heading-6": {
    fontSize: "var(--h6-size, 0.95em)",
    fontWeight: "var(--h6-weight, 600)",
    lineHeight: "1.5",
    color: "var(--h6-color, var(--text-muted, var(--vscode-descriptionForeground)))",
  },
  /* Revealed formatting markers (`**`, `*`, `#`, …) — dimmed while editing.
     Things overrides strong/em/quote with !important; this is the fallback for
     all marker kinds (Obsidian greys them too). */
  ".cm-formatting": {
    color: "var(--text-formatted, var(--text-faint, var(--vscode-disabledForeground)))",
    fontWeight: "var(--normal-weight, 400)",
  },

  /* Inline styling — always applied regardless of Reveal */
  ".ofm-strong": { fontWeight: "bold", color: "var(--bold-color, inherit)" },
  ".ofm-emphasis": { fontStyle: "italic", color: "var(--italic-color, inherit)" },
  ".ofm-strikethrough": { textDecoration: "line-through" },
  ".ofm-list-bullet": {
    color: "var(--list-marker-color, var(--text-muted, var(--vscode-descriptionForeground)))",
    fontWeight: "bold",
  },
  /* `.ofm-task-checkbox` appearance lives in obsidian-base.css (Obsidian-style
     box) so the active theme's per-task-type rules can layer on top. */
  /* Completed tasks dim (fallback when no theme provides it; Things overrides) */
  '.cm-line.HyperMD-task-line[data-task="x"], .cm-line.HyperMD-task-line[data-task="X"]':
    {
      color: "var(--text-faint, var(--vscode-disabledForeground, #888))",
    },
  ".ofm-image": {
    maxWidth: "100%",
    height: "auto",
    borderRadius: "4px",
    verticalAlign: "middle",
  },
  // ── Block-widget roots: PADDING, never MARGIN ───────────────────────────
  // CM6 measures a block widget by its root's border-box (margin is OUTSIDE it
  // and is NOT seen), then builds the internal height map used for coordinate↔
  // position mapping. A margin here desyncs that map → clicks/caret land ~one
  // line off for EVERYTHING below the widget. So spacing is padding, not margin.
  ".ofm-math-block": {
    display: "block",
    textAlign: "center",
    padding: "0.4em 0",
  },
  ".ofm-mermaid": {
    display: "block",
    textAlign: "center",
    padding: "0.5em 0",
  },
  ".ofm-table-wrap": { overflowX: "auto", padding: "0.5em 0" },
  ".ofm-table": { borderCollapse: "collapse" },
  ".ofm-table th": {
    border: "1px solid var(--background-modifier-border, rgba(128,128,128,0.3))",
    padding: "0.35em 0.75em",
    backgroundColor: "var(--background-secondary, rgba(128,128,128,0.12))",
    fontWeight: "bold",
  },
  ".ofm-table td": {
    border: "1px solid var(--background-modifier-border, rgba(128,128,128,0.3))",
    padding: "0.35em 0.75em",
  },
  ".ofm-mermaid-error": {
    color: "var(--vscode-errorForeground, #e05252)",
    whiteSpace: "pre-wrap",
    textAlign: "left",
    fontFamily: "var(--font-monospace, var(--vscode-editor-font-family, monospace))",
  },
  ".cm-line.ofm-codeblock": {
    // Fallback bg (when no theme is loaded); Things overrides via
    // .cm-s-obsidian div.HyperMD-codeblock-bg with its dedicated colour.
    backgroundColor:
      "var(--code-block-background, var(--code-background, var(--vscode-textCodeBlock-background, rgba(128,128,128,0.1))))",
    fontFamily: "var(--font-monospace, var(--vscode-editor-font-family, monospace))",
    fontSize: "0.9em",
    paddingLeft: "0.9em",
    paddingRight: "0.9em",
  },
  ".cm-line.ofm-codeblock-begin": {
    position: "relative", // anchor for the absolutely-positioned language label
    borderTopLeftRadius: "6px",
    borderTopRightRadius: "6px",
    paddingTop: "0.4em",
  },
  ".cm-line.ofm-codeblock-end": {
    borderBottomLeftRadius: "6px",
    borderBottomRightRadius: "6px",
    paddingBottom: "0.4em",
  },
  /* Collapse the ``` fence lines when not editing the block */
  ".cm-line.ofm-codeblock-fence": { display: "none" },
  /* Language label in the code block's top-right corner */
  ".ofm-code-lang": {
    position: "absolute",
    top: "0.15em",
    right: "0.7em",
    fontSize: "0.75em",
    lineHeight: "1.6",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "var(--code-comment, var(--text-muted, var(--vscode-descriptionForeground)))",
    opacity: "0.75",
    userSelect: "none",
    pointerEvents: "none",
  },

  /* Collapsed setext underline line (=== / ---) when not editing */
  ".cm-line.ofm-hidden-line": { display: "none" },

  ".cm-line.ofm-frontmatter": {
    color: "var(--text-faint, var(--vscode-descriptionForeground))",
    fontFamily: "var(--font-monospace, var(--vscode-editor-font-family, monospace))",
    fontSize: "0.85em",
    opacity: "0.75",
  },

  ".ofm-hr": {
    display: "inline-block",
    width: "100%",
    borderTop:
      "1px solid var(--hr-color, var(--vscode-editorWidget-border, rgba(128,128,128,0.4)))",
    verticalAlign: "middle",
  },

  /* Callouts — per-line border + tint form the box; title line is colored */
  ".cm-line.ofm-callout": {
    borderLeft: "3px solid var(--ofm-callout-color, #888)",
    backgroundColor: "rgba(128,128,128,0.08)",
    paddingLeft: "0.8em",
    paddingTop: "0.1em",
    paddingBottom: "0.1em",
  },
  ".cm-line.ofm-callout-title": {
    fontWeight: "bold",
    color: "var(--ofm-callout-color, #888)",
  },
  // Callout colors — full Obsidian type set INCLUDING aliases (real notes use
  // [!IMPORTANT], [!abstract], [!todo], [!failure], … which otherwise fall back
  // to the neutral gray default). Aliases share their family's color.
  ".cm-line.ofm-callout-note": { "--ofm-callout-color": "#448aff" },
  ".cm-line.ofm-callout-todo": { "--ofm-callout-color": "#448aff" },
  ".cm-line.ofm-callout-info": { "--ofm-callout-color": "#448aff" },
  ".cm-line.ofm-callout-abstract, .cm-line.ofm-callout-summary, .cm-line.ofm-callout-tldr": {
    "--ofm-callout-color": "#00b8d4",
  },
  ".cm-line.ofm-callout-tip, .cm-line.ofm-callout-hint, .cm-line.ofm-callout-important": {
    "--ofm-callout-color": "#00bcd4",
  },
  ".cm-line.ofm-callout-success, .cm-line.ofm-callout-check, .cm-line.ofm-callout-done": {
    "--ofm-callout-color": "#4caf50",
  },
  ".cm-line.ofm-callout-question, .cm-line.ofm-callout-help, .cm-line.ofm-callout-faq": {
    "--ofm-callout-color": "#e0a30e",
  },
  ".cm-line.ofm-callout-warning, .cm-line.ofm-callout-caution, .cm-line.ofm-callout-attention": {
    "--ofm-callout-color": "#ff9800",
  },
  ".cm-line.ofm-callout-failure, .cm-line.ofm-callout-fail, .cm-line.ofm-callout-missing": {
    "--ofm-callout-color": "#ff5252",
  },
  ".cm-line.ofm-callout-danger, .cm-line.ofm-callout-error": {
    "--ofm-callout-color": "#f44336",
  },
  ".cm-line.ofm-callout-bug": { "--ofm-callout-color": "#f50057" },
  ".cm-line.ofm-callout-example": { "--ofm-callout-color": "#7c4dff" },
  ".cm-line.ofm-callout-quote, .cm-line.ofm-callout-cite": {
    "--ofm-callout-color": "#9e9e9e",
  },

  ".ofm-highlight": {
    backgroundColor:
      "var(--text-highlight-bg, var(--vscode-editor-findMatchHighlightBackground, rgba(255,235,59,0.4)))",
    borderRadius: "2px",
  },
  ".ofm-tag": {
    color: "var(--tag-color, var(--vscode-textLink-foreground, #4ea1ff))",
    // Things sets --tag-background (no -color suffix); fall back to our blue.
    backgroundColor:
      "var(--tag-background, var(--tag-background-color, rgba(78,161,255,0.13)))",
    borderRadius: "8px",
    padding: "0 0.4em",
    fontSize: "0.9em",
  },
  ".ofm-internal-link": {
    color: "var(--link-color, var(--vscode-textLink-foreground, #4ea1ff))",
    textDecoration: "underline",
    cursor: "pointer",
  },
  /* Footnote label (`[^1]` refs and `[^1]:` definition markers) — superscript,
     small, accent-colored, like Obsidian. */
  ".ofm-footnote-ref": {
    verticalAlign: "super",
    fontSize: "0.7em",
    color: "var(--link-color, var(--vscode-textLink-foreground, #4ea1ff))",
    cursor: "pointer",
  },
  ".ofm-embed": {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.3em",
    padding: "0.05em 0.5em",
    border: "1px solid var(--background-modifier-border, rgba(128,128,128,0.35))",
    borderRadius: "6px",
    backgroundColor: "var(--background-secondary, rgba(128,128,128,0.08))",
    color: "var(--link-color, var(--vscode-textLink-foreground, #4ea1ff))",
    cursor: "pointer",
    textDecoration: "none",
  },
  ".ofm-embed:hover": {
    backgroundColor: "var(--background-modifier-hover, rgba(128,128,128,0.18))",
  },
  ".ofm-embed-icon": { fontSize: "0.85em", opacity: "0.8" },
  ".ofm-external-link": {
    color: "var(--link-external-color, var(--link-color, var(--vscode-textLink-foreground, #4ea1ff)))",
    textDecoration: "underline",
    cursor: "pointer",
  },

  /* Plain (non-callout) blockquote: left border + subtle tint. Text color/italic
     are left to the theme (Things colors the .cm-quote content), so we DON'T
     force a color/font-style here — that would override the theme. */
  ".cm-line.ofm-blockquote": {
    borderLeft: "3px solid var(--blockquote-border-color, var(--background-modifier-border, rgba(128,128,128,0.4)))",
    backgroundColor: "var(--blockquote-background-color, rgba(128,128,128,0.04))",
    paddingLeft: "0.8em",
  },
  /* Floating selection toolbar (Edit with AI / Add to Chat) above a selection */
  ".ofm-ai-toolbar": {
    position: "absolute",
    zIndex: "20",
    display: "flex",
    alignItems: "stretch",
    overflow: "hidden",
    backgroundColor:
      "var(--background-secondary, var(--vscode-editorWidget-background, #252526))",
    border:
      "1px solid var(--background-modifier-border, var(--vscode-editorWidget-border, rgba(128,128,128,0.3)))",
    borderRadius: "6px",
    boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
  },
  ".ofm-ai-button": {
    margin: "0",
    padding: "3px 10px",
    fontSize: "0.8em",
    fontWeight: "500",
    lineHeight: "1.5",
    whiteSpace: "nowrap",
    color: "var(--text-muted, var(--vscode-descriptionForeground, #8a8a8a))",
    backgroundColor: "transparent",
    border: "none",
    borderRadius: "0",
    cursor: "pointer",
    userSelect: "none",
    transition: "background-color 0.12s ease, color 0.12s ease",
  },
  /* Hairline divider between the two segments of the chip */
  ".ofm-ai-button + .ofm-ai-button": {
    borderLeft:
      "1px solid var(--background-modifier-border, var(--vscode-editorWidget-border, rgba(128,128,128,0.3)))",
  },
  ".ofm-ai-button:hover": {
    color:
      "var(--interactive-accent, var(--vscode-textLink-foreground, var(--vscode-button-background, #4a7dff)))",
    backgroundColor:
      "var(--background-modifier-hover, var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.12)))",
  },

  /* Find/replace panel (@codemirror/search) — match the VS Code chrome */
  ".cm-panels": {
    backgroundColor: "var(--vscode-editorWidget-background, var(--background-secondary, #252526))",
    color: "var(--vscode-editorWidget-foreground, var(--text-normal, inherit))",
    borderBottom: "1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3))",
  },
  ".cm-panel.cm-search": { padding: "6px 8px", fontSize: "0.85em" },
  ".cm-panel.cm-search label": { fontSize: "0.85em" },
  ".cm-textfield": {
    backgroundColor: "var(--vscode-input-background, #3c3c3c)",
    color: "var(--vscode-input-foreground, inherit)",
    border: "1px solid var(--vscode-input-border, rgba(128,128,128,0.4))",
    borderRadius: "3px",
    padding: "2px 5px",
  },
  ".cm-button": {
    backgroundColor: "var(--vscode-button-secondaryBackground, #3a3d41)",
    color: "var(--vscode-button-secondaryForeground, #fff)",
    border: "none",
    borderRadius: "3px",
    backgroundImage: "none",
    padding: "2px 8px",
    cursor: "pointer",
  },
  ".cm-button:hover": {
    backgroundColor: "var(--vscode-button-secondaryHoverBackground, #45494e)",
  },
  ".ofm-inline-code": {
    fontFamily: "var(--font-monospace, var(--vscode-editor-font-family, monospace))",
    backgroundColor:
      "var(--code-background, var(--vscode-textCodeBlock-background, rgba(128,128,128,0.15)))",
    color: "var(--code-normal, inherit)",
    borderRadius: "3px",
    padding: "0.1em 0.2em",
    fontSize: "0.9em",
  },
});

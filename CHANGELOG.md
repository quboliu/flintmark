# Changelog

All notable changes to Flintmark are documented here. Versions are pre-1.0 while
the editor stabilizes for the Marketplace.

## 0.28.1

- **Custom fonts for rendered Markdown.** Three new settings let the Live Preview
  use its own fonts, independent of the VS Code / Cursor editor font: `ofm.fontFamily`
  (prose — body text and headings), `ofm.fontSize` (prose size in px), and
  `ofm.monospaceFontFamily` (code blocks, inline code, frontmatter). Empty = follow
  the active theme / editor font, as before. Changes apply live (no reopen). The
  values feed dedicated `--ofm-*` override variables that sit at the front of the
  font cascade, so a chosen font wins over both the theme and the editor font.
  Backed by pure, unit-tested normalization (clamping + family sanitization) plus
  a webview e2e assertion.

## 0.28.0

- **Vault-wide image resolution.** Obsidian image embeds (`![[image.png]]`) and
  bare relative images now resolve across the whole vault: attachments kept in any
  folder and referenced by a bare name render correctly when an Obsidian vault is
  opened in VS Code (previously only same-folder images resolved). Adds `|W` /
  `|WxH` sizing. Backed by a per-workspace-root, path-only attachment index with
  synchronous resolution on the editor hot path; design reviewed adversarially.
- **Quality system.** Seed-reproducible chaos/fuzz tests, mutation testing
  (Stryker), coverage (c8), a consolidated metrics report, and a CI gate
  (lint + types + unit + chaos → webview e2e) plus a weekly deep run.

## 0.25.0

- **Rebrand to Flintmark** and Marketplace publish prep: extension icon,
  bilingual (English + 中文) README, this changelog, corrected third-party
  notices, and a leaner package (probe artifacts and dev files excluded).
- Prominent credit for the bundled **Things** theme (© Stephan Ango / maintained
  by Colin Eckert, MIT) in the README and `THIRD-PARTY-NOTICES.md`.

## 0.24.0

- AI Selection Bridge trace is mirrored to `/tmp/flintmark-ai.log` so it can be
  inspected outside the editor.

## 0.23.0

- Instrumented the AI Selection Bridge end-to-end (a "Flintmark AI" output
  channel tracing every hop) + the **Flintmark: Show AI Log** command and a
  manual test checklist. The Add-to-Chat / Edit round-trip was verified working
  in a logged-in Cursor.

## 0.22.0

- Footnotes: `[^1]` references and `[^1]:` definitions render as superscript
  labels with the bracket syntax hidden (reveal-gated).

## 0.21.0

- Callouts with no custom title now show the capitalized type name (e.g.
  "Note"), matching Obsidian.
- Obsidian `%% comments %%` are hidden in preview (revealed while editing);
  fenced-code `%%` (e.g. Mermaid) is left untouched.

## 0.20.0

- Full Obsidian callout type + alias color set (`[!important]`, `[!abstract]`,
  `[!todo]`, `[!failure]`, …) — previously these fell back to a gray box.

## 0.19.0

- Theme alignment with Things: body text font, heading sizes/weights from theme
  variables, dimmed formatting markers (`cm-formatting-*`), and Obsidian-style
  task checkboxes.

## 0.18.0

- Table cells pick up the active theme's inline colors (bold/italic/highlight/
  code), matching body text.

## 0.17.0

- Tolerant GFM table detection — tables whose delimiter row has trailing
  whitespace now render (previously dropped by the strict parser).

## 0.16.0 and earlier

- Live Preview foundation: in-place rendering for headings, bold/italic,
  inline/fenced code with syntax highlighting, quotes, callouts, lists, task
  checkboxes, tables, images, `![[embeds]]`, `[[wikilinks]]`, `#tags`,
  `==highlights==`, frontmatter, horizontal rules, KaTeX math, and Mermaid.
- Cursor-driven Reveal (raw syntax on the active line/block).
- Pluggable theme system with the **Things** theme bundled as default; variable-
  level Obsidian theme compatibility; configurable content width.
- AI Selection Bridge (reuse the host's native Copilot/Cursor AI), Outline and
  Backlinks panels, in-editor find/replace, and Live ↔ Code toggle.
- Markdown text stays the single source of truth on disk.

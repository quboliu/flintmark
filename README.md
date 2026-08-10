<p align="center">
  <img src="media/icon.png" width="96" alt="Flintmark icon">
</p>

<h1 align="center">Flintmark</h1>

<p align="center">
  <strong>Write Markdown as source. Read it as a finished note.</strong><br>
  Obsidian-style Live Preview, vault navigation, and native AI handoff inside VS Code.
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#product-tour">Product tour</a> ·
  <a href="#what-flintmark-understands">Syntax</a> ·
  <a href="#install">Install</a> ·
  <a href="#settings">Settings</a> ·
  <a href="#development">Development</a>
</p>

<p align="center">
  <a href="https://github.com/quboliu/flintmark/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/quboliu/flintmark/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/quboliu/flintmark/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/quboliu/flintmark?label=release"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=quboliu.flintmark"><img alt="VS Code Marketplace" src="https://img.shields.io/visual-studio-marketplace/v/quboliu.flintmark?label=VS%20Code%20Marketplace"></a>
  <img alt="VS Code 1.89+" src="https://img.shields.io/badge/VS_Code-1.89%2B-007ACC?logo=visualstudiocode&logoColor=white">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

Flintmark turns the Markdown editor itself into the preview. The line or block
under the cursor reveals its source syntax; the rest of the document stays
rendered and readable. There is no split preview, no proprietary database, and
no generated copy of the note—plain `.md` files remain the source of truth.

![Flintmark rendering a technical note with Properties, a callout, a table, and syntax-highlighted Go code](media/shots/go-pipelines-dark.png)

## Why Flintmark

| Principle | What it means in practice |
| --- | --- |
| Edit in context | Move the caret onto rendered content and its Markdown source appears exactly where you are writing. |
| Keep the vault portable | Notes, links, frontmatter, tasks, and embeds stay ordinary Markdown on disk. |
| Bring the useful parts of Obsidian | Wikilinks, callouts, Properties, task states, tags, highlights, vault-wide embeds, Outline, Todo, and Backlinks work inside VS Code. |
| Reuse the tools you already have | Selections can be handed to the host editor's native Copilot/Cursor editing and chat commands. |
| Stay responsive as the vault grows | Workspace indexes build cooperatively, saves update incrementally, and the editor paints before vault autocomplete is ready. |

## Product tour

The screenshots below come from the real extension running in a VS Code-compatible
workbench. They are not HTML mockups.

### One editor, two states

The document stays rendered until the caret enters a line or block. Headings,
lists, callouts, tables, code, math, and media can therefore be read and edited
without switching panes or modes.

<table>
  <tr>
    <td width="50%"><img src="media/shots/go-pipelines-dark.png" alt="Flintmark Live Preview in a dark VS Code theme"></td>
    <td width="50%"><img src="media/shots/go-pipelines-light.png" alt="Flintmark Live Preview in a light VS Code theme"></td>
  </tr>
  <tr>
    <td align="center"><strong>Dark</strong> — follows the active workbench theme</td>
    <td align="center"><strong>Light</strong> — switches in place without rebuilding the editor</td>
  </tr>
</table>

### Write without leaving Live Preview

Rendered task states remain clickable, fenced code keeps syntax highlighting and
a Copy action, and the active line exposes raw Markdown for direct editing.
Formatting shortcuts cover bold, italic, inline code, strikethrough, and links;
pasting a URL over selected text creates a Markdown link.

![Editing tasks, a fenced JavaScript block, a wikilink, and a tag directly in Flintmark](media/shots/editing.png)

Type `[[` for vault notes, `#` for vault tags, or `[[#` for headings in the
current note. Completion data updates as files change without recreating the
editor or losing its selection.

![Vault-note autocomplete open inside Flintmark Live Preview](media/shots/autocomplete.png)

### Frontmatter becomes Properties

Simple YAML frontmatter renders as a compact Properties panel with inferred type
icons and chips for arrays and tags. Click the panel to reveal and edit the YAML;
complex YAML safely falls back to source instead of being misrepresented.

![A Flintmark Properties panel showing text, date, list, and tag fields](media/shots/properties.png)

### Navigate the document and the vault

Flintmark supplies the views a webview editor cannot get from VS Code's built-in
Markdown Outline: a nested heading **Outline**, a live **Todo** list for standard
and extended task states, and vault-wide **Backlinks**. Selecting a heading or
task jumps to the exact source line in Live Preview.

![Flintmark with Outline, Todo, and Backlinks beside the rendered Project Notes document](media/shots/navigation.png)

### Rich Markdown, rendered where it lives

<table>
  <tr>
    <td width="50%">
      <strong>Callouts</strong><br>
      Common Obsidian types and aliases receive distinct titles and colors.<br><br>
      <img src="media/shots/callouts.png" alt="Note, tip, warning, and important callouts in Flintmark">
    </td>
    <td width="50%">
      <strong>Task states</strong><br>
      GFM tasks plus in-progress, cancelled, forwarded, and question states.<br><br>
      <img src="media/shots/tasks.png" alt="Standard and extended Markdown task states in Flintmark">
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>Syntax-highlighted code</strong><br>
      More than 30 fenced-code languages, language labels, and Copy actions.<br><br>
      <img src="media/shots/code.png" alt="SQL and Python code blocks with syntax highlighting">
    </td>
    <td width="50%">
      <strong>Editable GFM tables</strong><br>
      Rendered cells retain inline emphasis, code, links, and highlights.<br><br>
      <img src="media/shots/table.png" alt="A rendered GitHub Flavored Markdown table">
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>KaTeX math</strong><br>
      Inline formulas and single- or multi-line display math render in place.<br><br>
      <img src="media/shots/math.png" alt="Inline and display KaTeX math in Flintmark">
    </td>
    <td width="50%">
      <strong>Mermaid diagrams</strong><br>
      Mermaid loads only when needed and returns to source when edited.<br><br>
      <img src="media/shots/mermaid.png" alt="A rendered Mermaid flowchart in Flintmark">
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>Obsidian-flavored inline syntax</strong><br>
      Wikilinks, tags, highlights, footnotes, comments, and inline code.<br><br>
      <img src="media/shots/inline.png" alt="Wikilinks, tags, highlights, footnotes, and inline code">
    </td>
    <td width="50%">
      <strong>Images and attachments</strong><br>
      Standard images and vault-wide <code>![[embeds]]</code>, including explicit sizing.<br><br>
      <img src="media/shots/images.png" alt="A vault-wide image embed rendered in Flintmark">
    </td>
  </tr>
</table>

Flintmark also renders sanitized inline SVG blocks, blockquotes, ordered and
unordered lists, horizontal rules, Setext headings, footnote definitions, hidden
`%% comments %%`, and standard Markdown links and images.

### Paste and drop attachments

Paste or drag an image into a note and Flintmark saves it beside the Markdown
file, inserts a sanitized `![[name.ext]]` embed, avoids overwriting existing
files, and rejects unsupported or oversized payloads with a visible warning.
Bare image names can resolve across nested attachment folders in the vault;
`![[image.png|200]]` and `![[image.png|200x120]]` control display size.

### Reuse the editor's native AI

Flintmark does not ship a separate AI service. Instead, it bridges the selection
from the Live Preview webview back into the real source editor:

- **Edit** opens the matching source selection and can trigger the host's inline
  AI command.
- **Add to Chat** attaches the same selection to the host's chat or composer.

![The Edit and Add to Chat actions shown over a selection in Flintmark](media/shots/ai.png)

VS Code and Cursor command IDs are detected automatically, with settings for
host-specific overrides. Run **Flintmark: Show AI Log** when diagnosing a custom
host integration.

## Current capabilities

| Area | Delivered behavior |
| --- | --- |
| Live Preview | Cursor-driven source reveal; headings, emphasis, links, lists, quotes, callouts, tasks, tables, code, math, Mermaid, SVG, images, and embeds rendered in place |
| Editing | Markdown formatting shortcuts, smart URL paste, checkbox toggles, code Copy, find/replace, heading folding, Live ↔ Code switching |
| Metadata | Obsidian-style Properties panel for simple YAML; safe raw-source fallback for complex YAML |
| Vault | Wikilink/tag/heading completion, unresolved-link note creation, vault-wide image resolution, Outline, Todo, and Backlinks |
| Attachments | Image paste/drop, safe names, duplicate avoidance, size guard, standard Markdown images, `![[embed|W]]`, and `![[embed|WxH]]` |
| Themes | Bundled Things theme; live dark, light, and high-contrast adaptation; custom prose and monospace fonts; configurable reading width |
| AI handoff | Native host selection bridge for inline editing and chat; automatic host detection plus override and diagnostic settings |
| Reliability | Serialized document sync, coalesced structure refresh, cooperative/incremental vault indexes, measured rich-block layouts, and real-workbench E2E coverage |

## What Flintmark understands

- `[[wikilinks]]`, aliases, heading/block anchors, and unresolved-link creation.
- `#tags`, `==highlights==`, footnotes, and preview-hidden `%% comments %%`.
- Callouts such as `[!note]`, `[!tip]`, `[!warning]`, `[!important]`, `[!todo]`,
  `[!abstract]`, `[!failure]`, and their common aliases.
- Standard `[ ]` / `[x]` tasks plus `[/]` in progress, `[-]` cancelled, `[>]`
  forwarded, and `[?]` question.
- YAML frontmatter, GFM tables, fenced code, inline and display math, Mermaid,
  sanitized inline SVG, Markdown images, and Obsidian image embeds.

## Install

Install from the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=quboliu.flintmark),
search for **Flintmark** in the Extensions view, or run:

```sh
code --install-extension quboliu.flintmark
```

For a manual installation, download `flintmark-<version>.vsix` from
[GitHub Releases](https://github.com/quboliu/flintmark/releases), then choose
**Extensions → … → Install from VSIX…**.

Open a `.md` file and accept the prompt to make Flintmark the default Markdown
editor, or run **Flintmark: Switch to Live View**. Use **Switch to Code View**
whenever you want the conventional source editor.

### Set Live Preview as the default

Run **Flintmark: Set Live Preview as Default Markdown Editor**, or add:

```json
"workbench.editorAssociations": {
  "*.md": "ofm.livePreview",
  "*.markdown": "ofm.livePreview"
}
```

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `ofm.theme` | `things` | Bundled Live Preview theme. |
| `ofm.lineWidth` | `0` | `0` fills the pane with a stable side margin; `20`–`240` caps a centered column in `rem`. |
| `ofm.fontFamily` | theme | Font family for rendered prose, independent of the source editor font. |
| `ofm.fontSize` | `0` | Rendered prose size in px; `0` follows the editor size with Flintmark's offset. |
| `ofm.monospaceFontFamily` | editor | Font family for code, inline code, and frontmatter. |
| `ofm.ai.trigger` | `auto` | Trigger the detected native inline-AI command after bridging, or stop after selection handoff. |
| `ofm.ai.sourceLayout` | `replace` | Open the source selection in the current group or beside Live Preview. |
| `ofm.ai.chatBridge` | `split` | Use a transient side editor or briefly flip the current tab when attaching to chat. |
| `ofm.ai.chatCommand` / `ofm.ai.triggerCommand` | auto | Override host command IDs. |
| `ofm.ai.debugLog` | `false` | Trace AI handoff steps while troubleshooting. |

## How it stays plain Markdown

The VS Code `TextDocument` remains authoritative. Flintmark mirrors it into a
CodeMirror 6 webview, serializes edits back through the extension host, and
applies external updates without creating a second document format. Vault
indexes contain only derived paths, links, tags, and attachment metadata; they
can be rebuilt from the workspace.

The demo note used for the dark and light screenshots lives at
[media/demo/go-pipelines.md](media/demo/go-pipelines.md). It is a rewritten
technical fixture inspired by the Go blog post
[Go Concurrency Patterns: Pipelines and cancellation](https://go.dev/blog/pipelines),
not a copy of the article.

## Development

Flintmark requires Node.js 20 for the repository's CI baseline and VS Code 1.89
or newer for the extension host.

```sh
git clone https://github.com/quboliu/flintmark.git
cd flintmark
npm ci
npm run compile
```

Open the repository in VS Code and press `F5` to launch an Extension Development
Host. Useful quality gates:

```sh
npm run lint
npx tsc --noEmit -p .
npm run test:unit
npm run test:perf
npm run test:e2e
```

The README's primary demo and navigation screenshots are reproducible with:

```sh
npm run shots:go-pipelines
npm run shots:navigation
```

## Disclaimer

Flintmark is not affiliated with, endorsed by, or sponsored by Obsidian or
Dynalist Inc. “Obsidian” is a trademark of Dynalist Inc.; it is referenced only
to describe Markdown syntax and visual compatibility.

## Credits

- **Things** theme — © Stephan Ango
  ([@kepano](https://github.com/kepano)), Obsidian port maintained by Colin
  Eckert ([@colineckert](https://github.com/colineckert)), bundled under the MIT
  License ([source](https://github.com/colineckert/obsidian-things)). See
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- Built on [CodeMirror 6](https://codemirror.net/),
  [Lezer](https://lezer.codemirror.net/), [KaTeX](https://katex.org/), and
  [Mermaid](https://mermaid.js.org/).

## License

[MIT](LICENSE) © quboliu. Bundled third-party software is listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

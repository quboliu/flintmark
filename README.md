<div align="center">

<img src="media/icon.png" width="88" alt="Flintmark" />

# Flintmark

**Obsidian-style Markdown Live Preview for VS Code.**

English · [简体中文](README.zh-CN.md)

[![Release](https://img.shields.io/github/v/release/quboliu/flintmark?label=release)](https://github.com/quboliu/flintmark/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

Flintmark renders Markdown in place as you type. The line under the cursor keeps
its raw syntax; everything else becomes a readable preview. There is no split
pane, no separate preview file, and nothing proprietary on disk: your notes stay
plain Markdown.

## Preview

The screenshots below use a rewritten demo note inspired by the Go blog article
[Go Concurrency Patterns: Pipelines and cancellation](https://go.dev/blog/pipelines).
The demo adds frontmatter, callouts, a table, Go code, tags, highlights, and
wikilinks so the editor can be shown on a realistic technical note.

**Dark theme**

![Flintmark rendering a Go pipelines note in a dark VS Code theme](media/shots/go-pipelines-dark.png)

**Light theme**

![Flintmark rendering a Go pipelines note in a light VS Code theme](media/shots/go-pipelines-light.png)

## Highlights

| Area | What Flintmark does |
| --- | --- |
| Live Preview | Renders headings, emphasis, inline code, quotes, lists, task checkboxes, wikilinks, tags, highlights, comments, footnotes, tables, math, diagrams, and images directly in the editor. |
| Editing | Move the cursor onto a line to edit raw Markdown; move away and it renders again. Formatting shortcuts cover bold, italic, inline code, strike, and links. Pasting a URL over selected text creates a Markdown link. |
| Frontmatter | YAML frontmatter becomes a Properties panel with type icons and chips for list/tag values. Complex YAML falls back to a dimmed raw block. |
| Code | 30+ fenced-code languages are highlighted, including JS/TS, Python, Rust, Go, SQL, Shell, C/C++, C#, Java, PHP, Ruby, Kotlin, Swift, YAML, TOML, and Dockerfile. Rendered code blocks include a Copy button. |
| Tables | GFM tables render as HTML tables and can be edited in place. |
| Attachments | Local images and Obsidian embeds render inline. `![[image.png]]` resolves across the vault, and pasted or dropped images are saved next to the note. |
| Navigation | `[[` autocompletes vault notes, `#` autocompletes tags, and `[[#` autocompletes headings in the current note. Flintmark also ships its own Outline and Backlinks views because VS Code's built-in Outline cannot see webview editors. |
| Themes | The preview follows VS Code dark, light, and high-contrast themes without rebuilding the editor, so cursor position and scroll state survive theme changes. |

## Obsidian Syntax

Flintmark focuses on the Markdown syntax people already use in Obsidian-style
vaults:

- `[[wikilinks]]`, including unresolved links that can create a new note.
- `#tags`, `==highlights==`, and hidden `%% comments %%`.
- Callouts such as `[!note]`, `[!tip]`, `[!warning]`, `[!important]`, `[!todo]`,
  and the rest of the common Obsidian set.
- Task states beyond GitHub Markdown: `[/]` in progress, `[-]` cancelled,
  `[>]` forwarded, and `[?]` question.
- Image embeds with optional sizing: `![[image.png|200]]` or
  `![[image.png|200x120]]`.

## Reuse Your Editor's AI

Flintmark ships no AI of its own. A webview editor hides its selection from the
host, so Copilot, Cursor, and similar tools cannot naturally see what you select
inside Live Preview. Flintmark bridges that gap:

- **Edit** relocates the selection into the real source editor and triggers the
  host's inline AI command.
- **Add to Chat** sends the selection to the host's chat or composer command.

Command IDs are detected per host, with settings for overrides. Run
**Flintmark: Show AI Log** when diagnosing a host whose command names differ.

## Install

Download `flintmark-<version>.vsix` from
[GitHub Releases](https://github.com/quboliu/flintmark/releases), then install it
from **Extensions -> ... -> Install from VSIX...** or from a terminal:

```sh
code --install-extension flintmark-0.32.6.vsix
```

Open any `.md` file and accept the prompt to make Flintmark the default Markdown
editor, or run **Flintmark: Switch to Live View**. You can switch back with
**Switch to Code View** at any time.

### Set as the default Markdown editor

Missed the first-run prompt? Run
**Flintmark: Set Live Preview as Default Markdown Editor**, or add this setting:

```json
"workbench.editorAssociations": {
  "*.md": "ofm.livePreview",
  "*.markdown": "ofm.livePreview"
}
```

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `ofm.theme` | `things` | Bundled Live Preview theme. |
| `ofm.lineWidth` | `0` | `0` fills the editor width with a fixed margin; `20`-`240` caps a centered readable column in `rem`. |
| `ofm.fontFamily` | _(theme)_ | Prose font for rendered Markdown, independent of the editor font. |
| `ofm.fontSize` | `0` | Prose font size in px. `0` means editor font size + 2px. |
| `ofm.monospaceFontFamily` | _(editor)_ | Code font for fenced blocks, inline code, and frontmatter. |
| `ofm.ai.chatBridge` | `split` | How Add to Chat relocates the selection: `split` keeps the Live tab, `inplace` flips it. |
| `ofm.ai.sourceLayout` | `replace` | Where Edit opens the source editor: `replace` or `beside`. |
| `ofm.ai.trigger` | `auto` | Auto-trigger native inline AI, or leave it manual. |
| `ofm.ai.chatCommand`, `ofm.ai.triggerCommand` | _(auto)_ | Override native command IDs for your host. |

## Demo Source

The Markdown source used for the two screenshots lives at
[media/demo/go-pipelines.md](media/demo/go-pipelines.md). It is a rewritten demo
based on ideas from the Go blog post linked above, not a mirror of the original
article.

## Disclaimer

Not affiliated with, endorsed by, or sponsored by Obsidian or Dynalist Inc.
"Obsidian" is a trademark of Dynalist Inc., referenced here only descriptively to
state Markdown and visual compatibility.

## Credits

- **Things** theme - © Stephan Ango ([@kepano](https://github.com/kepano)),
  Obsidian port by Colin Eckert ([@colineckert](https://github.com/colineckert)).
  Bundled as the default theme under the MIT License
  ([source](https://github.com/colineckert/obsidian-things)). Full notice:
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- Built on [CodeMirror 6](https://codemirror.net/),
  [Lezer](https://lezer.codemirror.net/), [KaTeX](https://katex.org/), and
  [Mermaid](https://mermaid.js.org/).

## License

[MIT](LICENSE) © quboliu. Bundled third-party software: see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

// Obsidian-flavored inline syntax as @lezer/markdown extensions (ADR-0003):
//   ==highlight==   →  Highlight   (HighlightMark delimiters computed in view)
//   [[wikilink]]    →  WikiLink
//   #tag            →  Tag
// Host-independent parser config — no DOM, no VS Code. ofmMarkdown() is the
// single parser factory used by BOTH the editor and the headless tests, so they
// can never drift (a real bug we hit in Slice 2).
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { MarkdownConfig } from "@lezer/markdown";
import { HighlightStyle, StreamLanguage, type Language } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { yaml } from "@codemirror/lang-yaml";
import { sql, PostgreSQL, MySQL, SQLite } from "@codemirror/lang-sql";
import { php } from "@codemirror/lang-php";
import { sass } from "@codemirror/lang-sass";
// Long-tail languages via CodeMirror 5 legacy modes (the same approach Obsidian
// uses for broad coverage). Each mode is a separate module for tree-shaking.
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { r } from "@codemirror/legacy-modes/mode/r";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import {
  csharp,
  kotlin,
  scala,
  objectiveC,
  dart,
} from "@codemirror/legacy-modes/mode/clike";

const CH = {
  EQ: 61, // =
  LB: 91, // [
  RB: 93, // ]
  HASH: 35, // #
  NL: 10, // \n
  DOLLAR: 36, // $
  SP: 32, // space
  TAB: 9, // \t
} as const;

function isSpace(ch: number): boolean {
  return ch === CH.SP || ch === CH.TAB;
}
function isDigit(ch: number): boolean {
  return ch >= 48 && ch <= 57;
}

function isAlnum(ch: number): boolean {
  return (
    (ch >= 48 && ch <= 57) ||
    (ch >= 65 && ch <= 90) ||
    (ch >= 97 && ch <= 122)
  );
}
function isAlpha(ch: number): boolean {
  return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122);
}
function isTagChar(ch: number): boolean {
  return isAlnum(ch) || ch === 45 /* - */ || ch === 95 /* _ */ || ch === 47 /* / */;
}

/** ==highlight== */
const Highlight: MarkdownConfig = {
  defineNodes: ["Highlight"],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (next !== CH.EQ || cx.char(pos + 1) !== CH.EQ) return -1;
        for (let i = pos + 2; i <= cx.end - 2; i++) {
          if (cx.char(i) === CH.NL) return -1;
          if (cx.char(i) === CH.EQ && cx.char(i + 1) === CH.EQ) {
            if (i === pos + 2) return -1; // empty ====
            return cx.addElement(cx.elt("Highlight", pos, i + 2));
          }
        }
        return -1;
      },
    },
  ],
};

/** [[wikilink]] or [[target|alias]] */
const WikiLink: MarkdownConfig = {
  defineNodes: ["WikiLink"],
  parseInline: [
    {
      name: "WikiLink",
      before: "Link", // claim [[ before the standard link parser
      parse(cx, next, pos) {
        if (next !== CH.LB || cx.char(pos + 1) !== CH.LB) return -1;
        for (let i = pos + 2; i <= cx.end - 2; i++) {
          if (cx.char(i) === CH.NL) return -1;
          if (cx.char(i) === CH.RB && cx.char(i + 1) === CH.RB) {
            if (i === pos + 2) return -1; // empty [[]]
            return cx.addElement(cx.elt("WikiLink", pos, i + 2));
          }
        }
        return -1;
      },
    },
  ],
};

/** #tag (not preceded by a word char; body has at least one letter) */
const Tag: MarkdownConfig = {
  defineNodes: ["Tag"],
  parseInline: [
    {
      name: "Tag",
      parse(cx, next, pos) {
        if (next !== CH.HASH) return -1;
        const prev = pos > cx.offset ? cx.char(pos - 1) : -1;
        if (prev !== -1 && isAlnum(prev)) return -1; // e.g. "C#" / "a#b" is not a tag
        let i = pos + 1;
        let hasAlpha = false;
        while (i < cx.end && isTagChar(cx.char(i))) {
          if (isAlpha(cx.char(i))) hasAlpha = true;
          i++;
        }
        if (i === pos + 1 || !hasAlpha) return -1; // need ≥1 tag char incl. a letter
        return cx.addElement(cx.elt("Tag", pos, i));
      },
    },
  ],
};

/** $inline$ and $$display$$ math (single line). */
const Math: MarkdownConfig = {
  defineNodes: ["InlineMath", "BlockMath"],
  parseInline: [
    {
      name: "Math",
      parse(cx, next, pos) {
        if (next !== CH.DOLLAR) return -1;

        // $$display$$ (single line)
        if (cx.char(pos + 1) === CH.DOLLAR) {
          for (let i = pos + 2; i <= cx.end - 2; i++) {
            if (cx.char(i) === CH.NL) return -1;
            if (cx.char(i) === CH.DOLLAR && cx.char(i + 1) === CH.DOLLAR) {
              if (i === pos + 2) return -1;
              return cx.addElement(cx.elt("BlockMath", pos, i + 2));
            }
          }
          return -1;
        }

        // $inline$ — opening $ must be followed by non-space/non-$; closing $
        // must be preceded by non-space and not directly followed by a digit
        // (avoids matching currency like "$5 and $6").
        const afterOpen = cx.char(pos + 1);
        if (isSpace(afterOpen) || afterOpen === CH.DOLLAR || afterOpen === CH.NL) {
          return -1;
        }
        for (let i = pos + 2; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === CH.NL) return -1;
          if (c === CH.DOLLAR) {
            if (isSpace(cx.char(i - 1))) continue; // not a closing delimiter
            const after = i + 1 < cx.end ? cx.char(i + 1) : -1;
            if (isDigit(after)) return -1;
            return cx.addElement(cx.elt("InlineMath", pos, i + 1));
          }
        }
        return -1;
      },
    },
  ],
};

export const obsidianMarkdownExtensions: MarkdownConfig[] = [
  Highlight,
  WikiLink,
  Tag,
  Math,
];

/** Nested language for a fenced code block's info string (for syntax
 *  highlighting inside code blocks). A curated set; returns null otherwise. */
function codeLanguage(info: string): Language | null {
  const name = info.trim().toLowerCase().split(/\s+/)[0];
  switch (name) {
    case "javascript":
    case "js":
    case "node":
      return javascript().language;
    case "jsx":
      return javascript({ jsx: true }).language;
    case "typescript":
    case "ts":
      return javascript({ typescript: true }).language;
    case "tsx":
      return javascript({ typescript: true, jsx: true }).language;
    case "python":
    case "py":
      return python().language;
    case "rust":
    case "rs":
      return rust().language;
    case "go":
    case "golang":
      return go().language;
    case "json":
    case "jsonc":
      return json().language;
    case "html":
    case "xml":
    case "svg":
      return html().language;
    case "css":
      return css().language;
    case "c":
    case "cpp":
    case "c++":
    case "h":
    case "hpp":
      return cpp().language;
    case "java":
      return java().language;
    case "yaml":
    case "yml":
      return yaml().language;
    case "sql":
    case "tsql":
    case "plsql":
      return sql().language;
    case "postgres":
    case "postgresql":
    case "psql":
      return sql({ dialect: PostgreSQL }).language;
    case "mysql":
    case "mariadb":
      return sql({ dialect: MySQL }).language;
    case "sqlite":
      return sql({ dialect: SQLite }).language;
    case "php":
      return php({ plain: true }).language;
    case "scss":
      return sass({ indented: false }).language;
    case "sass":
      return sass({ indented: true }).language;
    case "less":
      return css().language;
    // ── Long-tail via legacy StreamLanguage modes ──────────────────────────
    case "shell":
    case "bash":
    case "sh":
    case "zsh":
    case "shellscript":
      return StreamLanguage.define(shell);
    case "csharp":
    case "cs":
    case "c#":
      return StreamLanguage.define(csharp);
    case "ruby":
    case "rb":
      return StreamLanguage.define(ruby);
    case "kotlin":
    case "kt":
    case "kts":
      return StreamLanguage.define(kotlin);
    case "swift":
      return StreamLanguage.define(swift);
    case "scala":
      return StreamLanguage.define(scala);
    case "objective-c":
    case "objectivec":
    case "objc":
      return StreamLanguage.define(objectiveC);
    case "dart":
      return StreamLanguage.define(dart);
    case "lua":
      return StreamLanguage.define(lua);
    case "r":
      return StreamLanguage.define(r);
    case "perl":
    case "pl":
      return StreamLanguage.define(perl);
    case "powershell":
    case "ps1":
    case "ps":
      return StreamLanguage.define(powerShell);
    case "toml":
      return StreamLanguage.define(toml);
    case "dockerfile":
    case "docker":
      return StreamLanguage.define(dockerFile);
    case "diff":
    case "patch":
      return StreamLanguage.define(diff);
    case "ini":
    case "properties":
    case "conf":
    case "cfg":
      return StreamLanguage.define(properties);
    case "haskell":
    case "hs":
      return StreamLanguage.define(haskell);
    case "clojure":
    case "clj":
    case "cljs":
    case "edn":
      return StreamLanguage.define(clojure);
    default:
      return null;
  }
}

/** The single Markdown LanguageSupport used by the editor AND the tests. */
export function ofmMarkdown() {
  return markdown({
    base: markdownLanguage,
    extensions: obsidianMarkdownExtensions,
    codeLanguages: codeLanguage,
  });
}

/**
 * Maps Lezer highlight tags to Obsidian's legacy `.cm-*` token classes, so a
 * bundled theme (scoped under .cm-s-obsidian) colors code tokens. This is the
 * "tag → class" link Obsidian's app provides; the theme provides the colors.
 */
export const ofmHighlightStyle = HighlightStyle.define([
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
      t.moduleKeyword,
      t.modifier,
      t.self,
    ],
    class: "cm-keyword",
  },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "cm-comment" },
  // Things colors strings/brackets only via the `.cm-hmd-codeblock.cm-string`
  // compound (bare .cm-string is uncolored). These tokens only occur inside
  // fenced code in our setup, so carrying cm-hmd-codeblock is accurate.
  {
    tag: [t.string, t.special(t.string), t.character, t.regexp],
    class: "cm-hmd-codeblock cm-string",
  },
  { tag: [t.number, t.integer, t.float], class: "cm-number" },
  { tag: [t.bool, t.null, t.atom], class: "cm-atom" },
  {
    tag: [
      t.operator,
      t.derefOperator,
      t.arithmeticOperator,
      t.logicOperator,
      t.bitwiseOperator,
      t.compareOperator,
    ],
    class: "cm-operator",
  },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: "cm-def" },
  { tag: [t.propertyName], class: "cm-property" },
  { tag: [t.typeName, t.className, t.namespace], class: "cm-type" },
  { tag: [t.tagName, t.angleBracket], class: "cm-tag" },
  { tag: [t.attributeName], class: "cm-attribute" },
  { tag: [t.meta, t.annotation, t.processingInstruction], class: "cm-meta" },
  { tag: [t.variableName], class: "cm-variable" },
  { tag: [t.definition(t.variableName), t.local(t.variableName)], class: "cm-variable-2" },
  { tag: [t.bracket, t.brace, t.paren, t.squareBracket], class: "cm-hmd-codeblock cm-bracket" },
]);

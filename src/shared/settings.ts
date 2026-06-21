// Pure settings normalization + CSS-variable mapping, shared by the extension
// (which reads raw VS Code config) and the webview (which applies CSS custom
// properties). Deliberately free of `vscode` and DOM dependencies so it unit-
// tests at L1 — the validation/clamping/sanitization is where bugs would hide.

import type { Settings } from "./protocol";

// Readable column width (rem) — mirror package.json's `ofm.lineWidth`.
// 0 = fill the editor width with a fixed margin (default, native-style); a
// positive value caps a centered readable column, clamped to [MIN, MAX].
export const DEFAULT_LINE_WIDTH = 0;
export const MIN_LINE_WIDTH = 20;
export const MAX_LINE_WIDTH = 240;

// Prose font-size (px) bounds. A value below MIN (incl. 0/unset) = no override
// (the rendered prose follows the VS Code editor font size + 2px).
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 72;

/** Untrusted raw config values, exactly as `workspace.getConfiguration` returns
 *  them (any user could put a string where a number is expected). */
export interface RawSettings {
  lineWidth?: unknown;
  fontFamily?: unknown;
  fontSize?: unknown;
  monospaceFontFamily?: unknown;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * A CSS font-family value lands in a custom property the webview sets via
 * `style.setProperty`. `setProperty` already refuses to break out into new
 * rules, but we still strip the characters that could smuggle in markup or a
 * stray declaration, while KEEPING every real font-name character — letters
 * (including CJK), digits, spaces, commas, quotes, hyphens, dots, underscores.
 * Returns undefined when nothing usable remains, i.e. "no override".
 */
export function sanitizeFontFamily(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw
    .replace(/[<>{};\\]/g, "") // CSS-injection / markup characters
    .replace(/[\u0000-\u001f\u007f]/g, "") // control characters
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Normalize raw VS Code config into the Settings object pushed to the webview.
 * `lineWidth` always resolves (clamped, or the default) to preserve existing
 * behavior; the font fields are OMITTED when there is no override so the webview
 * can tell "follow the theme/editor" apart from an explicit value.
 */
export function normalizeSettings(raw: RawSettings): Settings {
  // 0 (or negative) = fill the editor width; a positive value caps a centered
  // readable column, clamped to [MIN, MAX]. Non-numbers fall back to the default.
  let lineWidth: number;
  if (typeof raw.lineWidth === "number" && Number.isFinite(raw.lineWidth)) {
    lineWidth = raw.lineWidth <= 0 ? 0 : clamp(raw.lineWidth, MIN_LINE_WIDTH, MAX_LINE_WIDTH);
  } else {
    lineWidth = DEFAULT_LINE_WIDTH;
  }

  const settings: Settings = { lineWidth };

  const fontFamily = sanitizeFontFamily(raw.fontFamily);
  if (fontFamily) settings.fontFamily = fontFamily;

  const monospaceFontFamily = sanitizeFontFamily(raw.monospaceFontFamily);
  if (monospaceFontFamily) settings.monospaceFontFamily = monospaceFontFamily;

  // fontSize: a value at/above MIN takes effect (clamped to MAX); anything below
  // MIN — including the 0 default and negatives — means "no override".
  if (
    typeof raw.fontSize === "number" &&
    Number.isFinite(raw.fontSize) &&
    raw.fontSize >= MIN_FONT_SIZE
  ) {
    settings.fontSize = Math.min(MAX_FONT_SIZE, raw.fontSize);
  }

  return settings;
}

/** A custom-property assignment: a value to set, or `null` to remove it. */
export interface CssVar {
  name: string;
  value: string | null;
}

/**
 * Map Settings to the CSS custom properties the webview sets on the document
 * root. `null` means "remove the property" so that CLEARING a font in config
 * reverts live to the theme/editor default instead of sticking — the override
 * variables sit at the front of the cascade in obsidian-variables.css, so an
 * absent variable falls through to the theme value.
 */
export function settingsToCssVars(settings: Settings): CssVar[] {
  const lineWidth =
    typeof settings.lineWidth === "number" && settings.lineWidth > 0
      ? `${settings.lineWidth}rem`
      : null;
  const fontSize =
    typeof settings.fontSize === "number" && settings.fontSize > 0
      ? `${settings.fontSize}px`
      : null;
  return [
    { name: "--file-line-width", value: lineWidth },
    { name: "--ofm-font-family", value: settings.fontFamily ?? null },
    { name: "--ofm-font-monospace", value: settings.monospaceFontFamily ?? null },
    { name: "--ofm-font-size", value: fontSize },
  ];
}

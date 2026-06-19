// Registry of bundled themes. The active theme is just a setting (`ofm.theme`);
// switching is live. New built-in themes = drop a CSS file in media/themes/ and
// add an entry here. (Loading user/custom themes from disk is a later step — the
// webview only ever receives a CSS URI, so it doesn't care where it came from.)

export interface BundledTheme {
  /** Stable id used by the `ofm.theme` setting. */
  id: string;
  /** Human-readable name (shown in the theme picker). */
  name: string;
  /** CSS file path relative to the extension root. */
  file: string;
}

export const BUNDLED_THEMES: readonly BundledTheme[] = [
  { id: "things", name: "Things", file: "media/themes/things.css" },
  // More classic themes go here (e.g. minimal, default, …).
];

export const DEFAULT_THEME_ID = "things";

export function findTheme(id: string): BundledTheme | undefined {
  return BUNDLED_THEMES.find((t) => t.id === id);
}

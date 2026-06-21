// Pure helper for the "create note on clicking an unresolved [[wikilink]]"
// flow. Turns a raw link target into a safe Markdown filename to create next to
// the current note. No `vscode` import so it unit-tests at L1; the provider
// joins the result with the current note's folder and writes the file.

/**
 * Resolve a wikilink target to a safe new-note filename (e.g. `Foo.md`), or
 * null when the target can't be turned into one. The note is always created
 * with the link's basename in the current folder — alias (`|…`), heading/block
 * anchor (`#…`) and any folder path are stripped, so no directories are created
 * and path traversal is impossible.
 */
export function resolveNewNoteName(target: string): string | null {
  if (typeof target !== "string") return null;
  // Drop alias and heading/block anchor, then take the basename.
  let name = target.split("|")[0].split("#")[0].trim();
  if (!name) return null;
  const base = name.split(/[/\\]/).pop();
  if (base === undefined) return null;
  name = base.trim();
  if (!name || name === "." || name === "..") return null;
  // A user-typed extension is stripped; we always create a .md note.
  name = name.replace(/\.(md|markdown)$/i, "").trim();
  if (!name) return null;
  // Reject characters illegal in filenames on common platforms.
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) return null;
  return name + ".md";
}

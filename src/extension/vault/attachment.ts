// Pure helper for image paste/drop: derive a safe attachment filename from the
// pasted file's name + MIME type. Image types ONLY — the host refuses to write
// anything else, so a webview can't be coerced into writing arbitrary files. No
// `vscode` import → unit-testable; the host adds disk-uniqueness + writes bytes.

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

function extensionFor(filename: string, mime: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(filename || "");
  if (m && IMAGE_EXTS.has(m[1].toLowerCase())) {
    return m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
  }
  return MIME_EXT[(mime || "").toLowerCase()] ?? null;
}

/**
 * Build a sanitized `name.ext` for an attachment, or null when the input isn't a
 * supported image. `stamp` is a caller-supplied timestamp used when the pasted
 * data has no usable filename (e.g. a clipboard bitmap).
 */
export function attachmentName(
  filename: string,
  mime: string,
  stamp: string
): string | null {
  const ext = extensionFor(filename, mime);
  if (!ext) return null;

  let base = (filename || "").replace(/\.[^.]*$/, ""); // drop extension
  base = (base.split(/[/\\]/).pop() ?? "").trim(); // basename only (no dirs)
  // Strip filename-illegal chars AND wikilink-breaking chars (#, [, ], ^, |) so
  // the embed `![[name]]` resolves (the embed parser splits the target on # / |).
  base = base.replace(/[<>:"/\\|?*#[\]^]/g, "").trim();
  if (!base) base = `Pasted image ${stamp}`;

  return `${base}.${ext}`;
}

/** Insert `-1`, `-2`, … before the extension (for disk de-duplication). */
export function dedupeName(name: string, n: number): string {
  return name.replace(/(\.[^.]+)$/, `-${n}$1`);
}

// Pure image/attachment resolution (NO vscode, NO DOM — Node-testable). The
// host adapter (imageIndexService.ts) builds the per-workspace-root snapshots and
// turns a resolved entry into a webview URI; ALL the matching logic lives here so
// it is deterministic and unit-tested.
//
// Resolution mirrors Obsidian's behaviour for `![[name]]` (and relative
// `![](src)`): an explicit document-relative path wins; a bare filename resolves
// vault-wide by basename; a path with folders resolves by path-hint (a candidate
// whose path ends with those segments) and NEVER falls back to an arbitrary
// basename. Matching is case-insensitive + percent-decoded; ties prefer an
// exact-case basename, then the shorter path (see pathRank).

import { comparePathPreference } from "./pathRank";

/** Image file extensions we render (Obsidian's set). */
export const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif",
]);

/** One indexed image file, relative to its workspace root (original casing). */
export interface ImageEntry {
  /** Slash-separated path relative to the root, original casing. */
  relPath: string;
  /** relPath split into non-empty segments (original casing). */
  segments: string[];
  /** Last segment (filename), original casing. */
  basename: string;
  /** Lowercased extension without the dot (e.g. "png"). */
  ext: string;
}

export type SnapshotStatus = "ready" | "notReady" | "overCap" | "disabled";

/** Immutable per-root index. In any status other than "ready", callers must fall
 *  back to legacy document-relative behaviour (membership is only authoritative
 *  when "ready"). */
export interface ImageSnapshot {
  status: SnapshotStatus;
  /** normKey(relPath) → entry. */
  byRelKey: Map<string, ImageEntry>;
  /** normKey(basename) → entries sharing it. */
  byBaseKey: Map<string, ImageEntry[]>;
}

function decodeMaybe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Normalize a path/segment for case-insensitive, percent-decoded lookup. */
export function normKey(p: string): string {
  return decodeMaybe(p.replace(/\\/g, "/")).toLowerCase();
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Build an ImageEntry from a root-relative path string. */
export function makeEntry(relPath: string): ImageEntry {
  const rp = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = rp.split("/").filter((s) => s.length > 0);
  const basename = segments[segments.length - 1] ?? "";
  return { relPath: rp, segments, basename, ext: extOf(basename) };
}

/** Build an immutable snapshot from root-relative image paths. */
export function buildSnapshot(
  relPaths: readonly string[],
  status: SnapshotStatus = "ready"
): ImageSnapshot {
  const byRelKey = new Map<string, ImageEntry>();
  const byBaseKey = new Map<string, ImageEntry[]>();
  for (const rp of relPaths) {
    const e = makeEntry(rp);
    if (!e.basename) continue;
    byRelKey.set(normKey(e.relPath), e);
    const bk = normKey(e.basename);
    const list = byBaseKey.get(bk);
    if (list) list.push(e);
    else byBaseKey.set(bk, [e]);
  }
  return { status, byRelKey, byBaseKey };
}

/** Parsed Obsidian embed inner: the path part (key, matching the webview's
 *  `inner.split("|")[0].split("#")[0].trim()`) plus optional `|WxH` dimensions. */
export interface ParsedEmbed {
  /** Path part used both as the imageMap KEY and for resolution. */
  pathPart: string;
  width?: number;
  height?: number;
}

/** Parse `target#anchor|size` exactly as the webview keys it (first `|`, first
 *  `#`), and pull `|W` / `|WxH` dimensions from the first pipe segment. */
export function parseEmbedInner(inner: string): ParsedEmbed {
  const firstPipe = inner.indexOf("|");
  const head = firstPipe >= 0 ? inner.slice(0, firstPipe) : inner;
  const pathPart = head.split("#")[0].trim();
  let width: number | undefined;
  let height: number | undefined;
  if (firstPipe >= 0) {
    const size = inner.slice(firstPipe + 1).split("|")[0].trim();
    const m = /^(\d+)(?:x(\d+))?$/.exec(size);
    if (m) {
      width = Number(m[1]);
      if (m[2] !== undefined) height = Number(m[2]);
    }
  }
  return { pathPart, width, height };
}

function resolveDots(segs: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const s of segs) {
    if (s === "." || s === "") continue;
    if (s === "..") {
      if (out.length === 0) return null; // escapes the root
      out.pop();
    } else out.push(s);
  }
  return out;
}

function endsWithCi(pathSegs: readonly string[], hint: readonly string[]): boolean {
  if (hint.length > pathSegs.length) return false;
  const off = pathSegs.length - hint.length;
  for (let i = 0; i < hint.length; i++) {
    if (normKey(pathSegs[off + i]) !== normKey(hint[i])) return false;
  }
  return true;
}

function pickBest(list: readonly ImageEntry[], requestedBasename: string): ImageEntry {
  return [...list].sort((a, b) => {
    // Exact-case basename preferred over a case-only match...
    const ae = a.basename === requestedBasename ? 0 : 1;
    const be = b.basename === requestedBasename ? 0 : 1;
    if (ae !== be) return ae - be;
    // ...then shorter path, then lexicographic (shared rule).
    return comparePathPreference(a.segments, b.segments);
  })[0];
}

/**
 * Resolve a raw image reference (a markdown `src` or an embed pathPart) against a
 * snapshot, given the document's directory (segments relative to the same root).
 * Returns the matched ImageEntry or null. Returns null for non-"ready" snapshots
 * (caller falls back to legacy doc-relative).
 *
 * @param requireImageExt true for embeds (`![[x]]` must end in an image ext to be
 *   an image; otherwise it's a note embed and we don't resolve it here).
 */
export function resolveImageRef(
  snapshot: ImageSnapshot,
  docDirSegments: readonly string[],
  rawPath: string,
  requireImageExt: boolean
): ImageEntry | null {
  if (snapshot.status !== "ready") return null;
  const cleaned = rawPath.replace(/\\/g, "/").trim();
  if (!cleaned) return null;
  // Absolute paths are NEVER vault-resolved (would silently swap `/tmp/x.png`
  // for an unrelated `attachments/x.png`). Caller falls back to legacy Uri.file.
  // Covers POSIX `/…`, UNC `\\…` (→ `//…` after slash-normalisation), and
  // Windows drive paths `C:/…`.
  if (cleaned.startsWith("/") || /^[a-zA-Z]:\//.test(cleaned)) return null;
  const decoded = decodeMaybe(cleaned);
  const isRelativeMarker = decoded.startsWith("./") || decoded.startsWith("../");
  const segs = decoded.split("/").filter((s) => s.length > 0);
  if (segs.length === 0) return null;
  const base = segs[segs.length - 1];
  if (requireImageExt && !IMAGE_EXTS.has(extOf(base))) return null;

  // 1. Exact document-relative (covers same-folder `![[img.png]]` too).
  const relSegs = resolveDots([...docDirSegments, ...segs]);
  if (relSegs && relSegs.length > 0) {
    const hit = snapshot.byRelKey.get(normKey(relSegs.join("/")));
    if (hit) return hit;
  }
  // An explicit ./ or ../ reference is relative-ONLY — never vault-wide.
  if (isRelativeMarker) return null;

  // 2. Foldered reference → path-hint (suffix) match; never arbitrary basename.
  if (segs.length > 1) {
    const list = snapshot.byBaseKey.get(normKey(base));
    if (!list) return null;
    const matches = list.filter((e) => endsWithCi(e.segments, segs));
    return matches.length ? pickBest(matches, base) : null;
  }

  // 3. Bare filename → vault-wide basename match.
  const list = snapshot.byBaseKey.get(normKey(base));
  return list && list.length ? pickBest(list, base) : null;
}

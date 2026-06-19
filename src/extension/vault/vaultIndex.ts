// Vault Index · pure indexing core (NO vscode, NO DOM — Node-testable).
//
// Builds a workspace-wide link/tag index over a set of Notes ({path, text}) and
// answers the queries the Editing Surface + future panels need:
//   • resolveLink(name)  — wikilink target name → Note path (case-insensitive
//     basename match; path-hint / exact-case preference when ambiguous; null
//     when unresolved). This is what the editor's naive nav graduates into.
//   • getBacklinks(path) — reverse link graph.
//   • getTagged(tag)     — global tag index.
//   • getOutgoingLinks / getUnresolvedLinks / getAllNotes / getAllTags / getNote.
//
// "path" is an opaque identity string (an fs path or a URI string); the adapter
// chooses. Separators are normalised so `/` and `\` compare equal, and the
// `.md` / `.markdown` extension is ignored for name matching.

import { parseNote, WikiLinkRef } from "./linkParser";

/** Input unit: one Note and its current text. */
export interface NoteInput {
  path: string;
  text: string;
}

/** Indexed view of one Note. */
export interface NoteEntry {
  /** Identity path, exactly as supplied. */
  path: string;
  /** Basename without directory or `.md`/`.markdown` extension. */
  name: string;
  /** All outgoing wikilinks, in source order. */
  links: WikiLinkRef[];
  /** Unique tag texts (no `#`), de-duplicated case-insensitively, first-seen casing. */
  tags: string[];
}

// ---------------------------------------------------------------------------
// Path helpers (pure string ops; no fs).
// ---------------------------------------------------------------------------

function normSep(p: string): string {
  return p.replace(/\\/g, "/");
}
function stripMdExt(p: string): string {
  return p.replace(/\.(md|markdown)$/i, "");
}
/** Decode a percent-encoded path segment for NAME matching. Identity strings
 *  may be URI strings (e.g. `Other%20Note.md`), but wikilink targets are typed
 *  with real spaces (`Other Note`), so segments must compare decoded. */
function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
function segments(p: string): string[] {
  return stripMdExt(normSep(p))
    .split("/")
    .filter((s) => s.length > 0)
    .map(decodeSeg);
}
export function basenameNoExt(p: string): string {
  const segs = segments(p);
  return segs.length > 0 ? segs[segs.length - 1] : "";
}

// ---------------------------------------------------------------------------
// VaultIndex
// ---------------------------------------------------------------------------

export class VaultIndex {
  private readonly notes: NoteEntry[];
  private readonly byPath = new Map<string, NoteEntry>();
  /** lowercased basename → entries sharing it (for resolveLink candidates). */
  private readonly byName = new Map<string, NoteEntry[]>();
  /** target Note path → source Note paths that link to it. */
  private readonly backlinks = new Map<string, Set<string>>();
  /** source Note path → resolved target Note paths. */
  private readonly outgoing = new Map<string, Set<string>>();
  /** source Note path → unresolved target names (as written). */
  private readonly unresolved = new Map<string, Set<string>>();
  /** lowercased tag → Note paths carrying it. */
  private readonly tagged = new Map<string, Set<string>>();

  constructor(inputs: NoteInput[]) {
    this.notes = inputs.map((n) => this.toEntry(n));
    for (const e of this.notes) {
      this.byPath.set(e.path, e);
      const key = e.name.toLowerCase();
      const list = this.byName.get(key);
      if (list) list.push(e);
      else this.byName.set(key, [e]);
      for (const t of e.tags) {
        const tk = t.toLowerCase();
        const set = this.tagged.get(tk) ?? new Set<string>();
        set.add(e.path);
        this.tagged.set(tk, set);
      }
    }
    this.buildLinkGraph();
  }

  private toEntry(input: NoteInput): NoteEntry {
    const { links, tags } = parseNote(input.text);
    const seen = new Set<string>();
    const uniqueTags: string[] = [];
    for (const t of tags) {
      const k = t.tag.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      uniqueTags.push(t.tag);
    }
    return {
      path: input.path,
      name: basenameNoExt(input.path),
      links,
      tags: uniqueTags,
    };
  }

  private buildLinkGraph(): void {
    for (const src of this.notes) {
      const out = new Set<string>();
      const miss = new Set<string>();
      for (const link of src.links) {
        if (!link.target) continue; // e.g. [[#Heading]] — same-note, no target
        const targetPath = this.resolveLink(link.target);
        if (targetPath !== null) {
          out.add(targetPath);
          const back = this.backlinks.get(targetPath) ?? new Set<string>();
          back.add(src.path);
          this.backlinks.set(targetPath, back);
        } else {
          miss.add(link.target);
        }
      }
      if (out.size > 0) this.outgoing.set(src.path, out);
      if (miss.size > 0) this.unresolved.set(src.path, miss);
    }
  }

  // ----- queries ---------------------------------------------------------

  /** Every indexed Note, sorted by path for determinism. */
  getAllNotes(): NoteEntry[] {
    return [...this.notes].sort((a, b) => cmp(a.path, b.path));
  }

  /** The entry for an exact path, or undefined. */
  getNote(path: string): NoteEntry | undefined {
    return this.byPath.get(path);
  }

  /**
   * Resolve a wikilink target name to a Note path.
   *   • case-insensitive match on basename (extension ignored);
   *   • when multiple Notes share the name, prefer a path-hint match
   *     (`folder/Note`) and exact-case basename, then the shortest path;
   *   • null when nothing matches.
   */
  resolveLink(name: string): string | null {
    const raw = name.trim();
    if (!raw) return null;
    const targetSegs = segments(raw);
    if (targetSegs.length === 0) return null;
    const wantName = targetSegs[targetSegs.length - 1].toLowerCase();

    const candidates = this.byName.get(wantName);
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].path;

    let best: NoteEntry | null = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const score = scoreCandidate(segments(c.path), targetSegs);
      if (
        best === null ||
        score > bestScore ||
        (score === bestScore && preferOver(c.path, best.path))
      ) {
        best = c;
        bestScore = score;
      }
    }
    return best ? best.path : null;
  }

  /** Resolved outgoing target paths for a Note (deduped, sorted). */
  getOutgoingLinks(path: string): string[] {
    return sortedFrom(this.outgoing.get(path));
  }

  /** Target names from a Note that resolved to no Note (deduped, sorted). */
  getUnresolvedLinks(path: string): string[] {
    return sortedFrom(this.unresolved.get(path));
  }

  /** Note paths that link to the given Note (deduped, sorted). */
  getBacklinks(path: string): string[] {
    return sortedFrom(this.backlinks.get(path));
  }

  /** Note paths carrying the given tag (case-insensitive, `#` optional; sorted). */
  getTagged(tag: string): string[] {
    const key = tag.replace(/^#/, "").toLowerCase();
    return sortedFrom(this.tagged.get(key));
  }

  /** All tags across the vault (lowercased, sorted). */
  getAllTags(): string[] {
    return [...this.tagged.keys()].sort(cmp);
  }
}

/** Build a VaultIndex from a set of Notes. */
export function buildVaultIndex(inputs: NoteInput[]): VaultIndex {
  return new VaultIndex(inputs);
}

// ---------------------------------------------------------------------------
// ranking + ordering helpers
// ---------------------------------------------------------------------------

function scoreCandidate(pathSegs: string[], targetSegs: string[]): number {
  let score = 0;
  const pName = pathSegs[pathSegs.length - 1] ?? "";
  const tName = targetSegs[targetSegs.length - 1] ?? "";
  if (pName === tName) score += 4; // exact-case basename

  if (targetSegs.length > 1) {
    const offset = pathSegs.length - targetSegs.length;
    if (offset >= 0) {
      let exact = true;
      let ci = true;
      for (let k = 0; k < targetSegs.length; k++) {
        const ps = pathSegs[offset + k];
        if (ps !== targetSegs[k]) exact = false;
        if (ps.toLowerCase() !== targetSegs[k].toLowerCase()) ci = false;
      }
      if (exact) score += 8;
      else if (ci) score += 6;
    }
  }
  return score;
}

/** Deterministic tiebreak: shorter path wins, then lexicographic. */
function preferOver(candidate: string, current: string): boolean {
  const cs = segments(candidate).length;
  const ds = segments(current).length;
  if (cs !== ds) return cs < ds;
  return cmp(candidate, current) < 0;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedFrom(set: Set<string> | undefined): string[] {
  return set ? [...set].sort(cmp) : [];
}

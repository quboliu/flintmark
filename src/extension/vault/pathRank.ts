// Pure path-preference ranking, shared by name-based resolution (wikilinks and
// image attachments): when several candidate paths match a requested name, prefer
// the SHORTER path (fewer segments), then lexicographic order. This mirrors the
// note resolver's tiebreak in vaultIndex.ts (preferOver) so attachments resolve
// by the same rule; it is kept pure + standalone so it is trivially unit-testable
// and reusable without disturbing the mutation-hardened vaultIndex core.

/**
 * Comparator over candidate paths given as segment arrays.
 * Negative → `a` is preferred (sorts first). Shorter path wins; ties break
 * lexicographically on the slash-joined segments.
 */
export function comparePathPreference(
  a: readonly string[],
  b: readonly string[]
): number {
  if (a.length !== b.length) return a.length - b.length;
  const aj = a.join("/");
  const bj = b.join("/");
  return aj < bj ? -1 : aj > bj ? 1 : 0;
}

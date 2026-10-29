/** Decode a local note target once, keeping glob characters literal. */
export function noteLinkTarget(target: string): string {
  const path = target.split("|")[0].split("#")[0].split("^")[0].trim();
  try {
    return decodeURIComponent(path).replace(/\\/g, "/");
  } catch {
    return path.replace(/\\/g, "/");
  }
}

/** Extensionless wikilinks support both note extensions without doubling .md. */
export function noteLinkCandidates(target: string): string[] {
  if (!target) return [];
  return /\.(md|markdown)$/i.test(target) ? [target] : [target + ".md", target + ".markdown"];
}

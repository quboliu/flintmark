// Vault Index subsystem — public API barrel (CONTEXT.md → "Vault Index").
//
// The host wires this in later (NOT done in activate.ts here). For the editor's
// naive wikilink nav graduating to real resolution:
//   const svc = new VaultIndexService();
//   await svc.initialize();
//   context.subscriptions.push(svc);
//   const uri = svc.resolveLinkUri(target);
//
// Pure core (no vscode) is exported too, for direct/headless use and tests.

export {
  parseNote,
  extractWikiLinks,
  extractTags,
} from "./linkParser";
export type { WikiLinkRef, TagRef, ParsedNote } from "./linkParser";

export {
  VaultIndex,
  buildVaultIndex,
  basenameNoExt,
} from "./vaultIndex";
export type { NoteInput, NoteEntry } from "./vaultIndex";

export { VaultIndexService } from "./vaultIndexService";

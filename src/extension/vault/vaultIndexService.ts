// Vault Index · thin VS Code adapter (MAY import vscode).
//
// All real logic lives in the pure core (vaultIndex.ts / linkParser.ts). This
// file only does host plumbing: scan `.md` Notes, read their text, build the
// index, and keep it fresh via a FileSystemWatcher. It exposes the same query
// surface as the core, mapping between VS Code Uris and the core's opaque path
// strings (here: `uri.toString()`).
//
// NOT wired into activate.ts — the host wires this in later. Typical use:
//   const svc = new VaultIndexService();
//   await svc.initialize();
//   context.subscriptions.push(svc);
//   const uri = svc.resolveLinkUri("Some Note");

import * as vscode from "vscode";
import { buildVaultIndex, NoteEntry, NoteInput, VaultIndex } from "./vaultIndex";

const MD_GLOB = "**/*.md";
const EXCLUDE_GLOB = "**/{node_modules,.git}/**";
const REBUILD_DEBOUNCE_MS = 50;

export class VaultIndexService implements vscode.Disposable {
  /** path (uri.toString()) → current text. The single source the index is built from. */
  private readonly texts = new Map<string, string>();
  /** path → Uri, so resolved paths can be turned back into openable Uris. */
  private readonly uris = new Map<string, vscode.Uri>();
  private index: VaultIndex = buildVaultIndex([]);
  private watcher: vscode.FileSystemWatcher | undefined;
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly decoder = new TextDecoder();

  /** Scan the workspace and start watching. Safe to await once at activation. */
  async initialize(): Promise<void> {
    const files = await vscode.workspace.findFiles(MD_GLOB, EXCLUDE_GLOB);
    await Promise.all(files.map((uri) => this.loadFile(uri)));
    this.rebuildNow();

    this.watcher = vscode.workspace.createFileSystemWatcher(MD_GLOB);
    this.watcher.onDidCreate((uri) => this.onChanged(uri));
    this.watcher.onDidChange((uri) => this.onChanged(uri));
    this.watcher.onDidDelete((uri) => this.onDeleted(uri));
  }

  // ----- queries (delegate straight to the pure core) --------------------

  getAllNotes(): NoteEntry[] {
    return this.index.getAllNotes();
  }
  getBacklinks(uri: vscode.Uri): string[] {
    return this.index.getBacklinks(uri.toString());
  }
  getOutgoingLinks(uri: vscode.Uri): string[] {
    return this.index.getOutgoingLinks(uri.toString());
  }
  getUnresolvedLinks(uri: vscode.Uri): string[] {
    return this.index.getUnresolvedLinks(uri.toString());
  }
  getTagged(tag: string): string[] {
    return this.index.getTagged(tag);
  }
  getAllTags(): string[] {
    return this.index.getAllTags();
  }

  /** Resolve a wikilink target name → Note path string, or null. */
  resolveLink(name: string): string | null {
    return this.index.resolveLink(name);
  }

  /** Resolve a wikilink target name → openable Uri, or undefined. */
  resolveLinkUri(name: string): vscode.Uri | undefined {
    const path = this.index.resolveLink(name);
    return path ? this.uris.get(path) : undefined;
  }

  // ----- watcher plumbing ------------------------------------------------

  private async onChanged(uri: vscode.Uri): Promise<void> {
    if (isExcluded(uri)) return;
    await this.loadFile(uri);
    this.scheduleRebuild();
  }

  private onDeleted(uri: vscode.Uri): void {
    const key = uri.toString();
    this.texts.delete(key);
    this.uris.delete(key);
    this.scheduleRebuild();
  }

  private async loadFile(uri: vscode.Uri): Promise<void> {
    if (isExcluded(uri)) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.texts.set(uri.toString(), this.decoder.decode(bytes));
      this.uris.set(uri.toString(), uri);
    } catch {
      // Unreadable (deleted mid-flight, perms): drop it from the index.
      this.texts.delete(uri.toString());
      this.uris.delete(uri.toString());
    }
  }

  /** Coalesce bursts (save storms, multi-file ops) into one rebuild. */
  private scheduleRebuild(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      this.rebuildNow();
    }, REBUILD_DEBOUNCE_MS);
  }

  private rebuildNow(): void {
    const inputs: NoteInput[] = [];
    for (const [path, text] of this.texts) inputs.push({ path, text });
    this.index = buildVaultIndex(inputs);
  }

  dispose(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.watcher?.dispose();
  }
}

function isExcluded(uri: vscode.Uri): boolean {
  return /[/\\](node_modules|\.git)[/\\]/.test(uri.path);
}

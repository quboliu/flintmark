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
import type { VaultData } from "../../shared/protocol";
import {
  WorkspaceIndexDriver,
  type WorkspaceIndexHandle,
} from "./workspaceIndexDriver";

const MD_GLOB = "**/*.{md,markdown}";
const EXCLUDE_GLOB = "**/{node_modules,.git}/**";
const REBUILD_DEBOUNCE_MS = 50;

interface VaultRootSnapshot {
  inputs: NoteInput[];
  uris: Map<string, vscode.Uri>;
}

function emptyRootSnapshot(): VaultRootSnapshot {
  return { inputs: [], uris: new Map() };
}

export class VaultIndexService implements vscode.Disposable {
  private readonly driver: WorkspaceIndexDriver;
  private readonly ownsDriver: boolean;
  private readonly handle: WorkspaceIndexHandle<VaultRootSnapshot>;
  private index: VaultIndex = buildVaultIndex([]);
  private uris = new Map<string, vscode.Uri>();
  private readonly refreshSub: vscode.Disposable;
  private readonly decoder = new TextDecoder();

  /** Fires after every (debounced) rebuild so views can refresh (e.g. push
   *  fresh autocomplete data to webviews). */
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(driver?: WorkspaceIndexDriver) {
    this.driver = driver ?? new WorkspaceIndexDriver();
    this.ownsDriver = driver === undefined;
    this.handle = this.driver.registerSpec<VaultRootSnapshot>({
      kind: "note",
      include: MD_GLOB,
      exclude: EXCLUDE_GLOB,
      debounceMs: REBUILD_DEBOUNCE_MS,
      watchContent: true,
      notReady: emptyRootSnapshot,
      disabled: emptyRootSnapshot,
      build: (root, files) => this.buildSnapshot(root, files),
    });
    this.refreshSub = this.driver.onDidRefresh((event) => {
      if (event.kind !== "note") return;
      this.rebuildGlobalSnapshot();
      this._onDidChange.fire();
    });
  }

  /** Scan the workspace and start watching. Safe to await once at activation. */
  async initialize(): Promise<void> {
    await this.driver.initialize();
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

  /** Compact data for webview autocomplete: deduped note names + all tags. */
  getVaultData(): VaultData {
    const notes = [...new Set(this.index.getAllNotes().map((n) => n.name).filter((s) => s.length > 0))].sort();
    return { notes, tags: this.index.getAllTags() };
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

  private async buildSnapshot(
    _root: vscode.Uri,
    files: readonly vscode.Uri[]
  ): Promise<VaultRootSnapshot> {
    const inputs: NoteInput[] = [];
    const uris = new Map<string, vscode.Uri>();
    await Promise.all(
      files.map(async (uri) => {
        if (isExcluded(uri)) return;
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const key = uri.toString();
          inputs.push({ path: key, text: this.decoder.decode(bytes) });
          uris.set(key, uri);
        } catch {
          // Unreadable/deleted mid-scan: omit it from this reconciled snapshot.
        }
      })
    );
    return { inputs, uris };
  }

  private rebuildGlobalSnapshot(): void {
    const inputs: NoteInput[] = [];
    const uris = new Map<string, vscode.Uri>();
    for (const { snapshot } of this.handle.snapshots()) {
      inputs.push(...snapshot.inputs);
      for (const [key, uri] of snapshot.uris) uris.set(key, uri);
    }
    this.index = buildVaultIndex(inputs);
    this.uris = uris;
  }

  dispose(): void {
    this.refreshSub.dispose();
    this._onDidChange.dispose();
    if (this.ownsDriver) this.driver.dispose();
  }
}

function isExcluded(uri: vscode.Uri): boolean {
  return /[/\\](node_modules|\.git)[/\\]/.test(uri.path);
}

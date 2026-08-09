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
import {
  buildVaultIndex,
  buildVaultIndexCooperatively,
  NoteEntry,
  NoteInput,
  VaultIndex,
  VaultIndexBuildCancelled,
} from "./vaultIndex";
import type { VaultData } from "../../shared/protocol";
import { mapInCooperativeBatches } from "./cooperativeBatches";
import { patchNoteSnapshot, type NoteSnapshot } from "./vaultSnapshot";
import {
  WorkspaceIndexDriver,
  WorkspaceIndexBuildCancelled,
  type WorkspaceIndexBuildContext,
  type WorkspaceIndexHandle,
} from "./workspaceIndexDriver";

const MD_GLOB = "**/*.{md,markdown}";
const EXCLUDE_GLOB = "**/{node_modules,.git}/**";
const REBUILD_DEBOUNCE_MS = 50;
const READ_CONCURRENCY = 32;
const BUILD_SLICE_MS = 8;

type VaultRootSnapshot = NoteSnapshot<vscode.Uri>;

function emptyRootSnapshot(): VaultRootSnapshot {
  return { inputs: new Map(), uris: new Map() };
}

export class VaultIndexService implements vscode.Disposable {
  private readonly driver: WorkspaceIndexDriver;
  private readonly ownsDriver: boolean;
  private readonly handle: WorkspaceIndexHandle<VaultRootSnapshot>;
  private index: VaultIndex = buildVaultIndex([]);
  private uris = new Map<string, vscode.Uri>();
  private vaultData: VaultData = { notes: [], tags: [] };
  private readonly refreshSub: vscode.Disposable;
  private readonly decoder = new TextDecoder();
  private rebuildGeneration = 0;
  private fullRebuildInFlight: number | undefined;
  private rebuildPromise: Promise<void> = Promise.resolve();
  private disposed = false;

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
      build: (root, files, context) => this.buildSnapshot(root, files, context),
      patchSnapshot: (_root, snapshot, changedUris, context) =>
        this.patchSnapshot(snapshot, changedUris, context),
    });
    this.refreshSub = this.driver.onDidRefresh((event) => {
      if (event.kind !== "note") return;
      if (event.mode === "content") this.applyContentRefresh(event.root, event.changedUris);
      else this.scheduleGlobalRebuild();
    });
  }

  /** Scan the workspace and start watching. Safe to await once at activation. */
  async initialize(): Promise<void> {
    await this.driver.initialize();
    await this.rebuildPromise;
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
    return this.vaultData;
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
    files: readonly vscode.Uri[],
    context: WorkspaceIndexBuildContext
  ): Promise<VaultRootSnapshot> {
    const inputs = new Map<string, NoteInput>();
    const uris = new Map<string, vscode.Uri>();
    const results = await mapInCooperativeBatches(
      files,
      READ_CONCURRENCY,
      async (uri): Promise<{ input: NoteInput; uri: vscode.Uri } | undefined> => {
        if (isExcluded(uri)) return;
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const key = uri.toString();
          return { input: { path: key, text: this.decoder.decode(bytes) }, uri };
        } catch {
          // Unreadable/deleted mid-scan: omit it from this reconciled snapshot.
          return undefined;
        }
      },
      {
        assertCurrent: () => {
          if (!context.isCurrent()) throw new WorkspaceIndexBuildCancelled();
        },
        // readFile already yields for I/O, but this explicit macrotask boundary
        // prevents a hot cache from becoming one long microtask train.
        yieldNow: context.yieldNow,
      }
    );
    for (const result of results) {
      if (!result) continue;
      inputs.set(result.input.path, result.input);
      uris.set(result.input.path, result.uri);
    }
    return { inputs, uris };
  }

  private async patchSnapshot(
    snapshot: VaultRootSnapshot,
    changedUris: readonly vscode.Uri[],
    context: WorkspaceIndexBuildContext
  ): Promise<VaultRootSnapshot | undefined> {
    return patchNoteSnapshot(
      snapshot,
      changedUris,
      (uri) => uri.toString(),
      async (uri) => this.decoder.decode(await vscode.workspace.fs.readFile(uri)),
      () => {
        if (!context.isCurrent()) throw new WorkspaceIndexBuildCancelled();
      }
    );
  }

  private scheduleGlobalRebuild(): void {
    const generation = ++this.rebuildGeneration;
    this.fullRebuildInFlight = generation;
    const promise = this.rebuildGlobalSnapshot(generation);
    this.rebuildPromise = promise;
    void promise;
  }

  private async rebuildGlobalSnapshot(generation: number): Promise<void> {
    const inputs: NoteInput[] = [];
    const uris = new Map<string, vscode.Uri>();
    for (const { snapshot } of this.handle.snapshots()) {
      inputs.push(...snapshot.inputs.values());
      for (const [key, uri] of snapshot.uris) uris.set(key, uri);
    }
    try {
      const index = await buildVaultIndexCooperatively(inputs, {
        now: monotonicNow,
        yieldNow: yieldImmediate,
        shouldCancel: () => this.disposed || generation !== this.rebuildGeneration,
        maxSliceMs: BUILD_SLICE_MS,
      });
      if (this.disposed || generation !== this.rebuildGeneration) return;
      const vaultData = makeVaultData(index);
      // One synchronous publication transaction: no observer can see a new
      // graph paired with old URI/VaultData caches.
      this.index = index;
      this.uris = uris;
      this.vaultData = vaultData;
      this._onDidChange.fire();
    } catch (error) {
      if (error instanceof VaultIndexBuildCancelled) return;
      // Retain the last complete index. A later dirty/notReady document request
      // will retry because only successful publication advances freshness.
      console.error("[ofm] vault index rebuild failed", error);
    } finally {
      if (this.fullRebuildInFlight === generation) this.fullRebuildInFlight = undefined;
    }
  }

  private applyContentRefresh(root: vscode.Uri, changedUris: readonly vscode.Uri[]): void {
    const snapshot = this.handle.snapshot(root);
    const inputs = changedUris.flatMap((uri) => {
      const input = snapshot?.inputs.get(uri.toString());
      return input ? [input] : [];
    });
    if (!snapshot || inputs.length !== changedUris.length) {
      this.handle.requestRefresh(root, "content-patch-missing", true);
      return;
    }
    // A structural snapshot may be newer than the currently published graph.
    // Rebuild from the driver's latest (already content-patched) snapshots so
    // cancelling that build cannot discard creates/deletes/renames.
    if (this.fullRebuildInFlight !== undefined) {
      this.scheduleGlobalRebuild();
      return;
    }
    // Cancel any cooperative full rebuild before mutating the last published
    // graph. Validate the entire batch first so publication is all-or-nothing.
    this.rebuildGeneration++;
    if (inputs.some((input) => !this.index.getNote(input.path))) {
      this.handle.requestRefresh(root, "content-patch-index-missing", true);
      return;
    }
    for (const input of inputs) this.index.replaceNoteContent(input);
    this.vaultData = makeVaultData(this.index);
    this.rebuildPromise = Promise.resolve();
    this._onDidChange.fire();
  }

  dispose(): void {
    this.disposed = true;
    this.rebuildGeneration++;
    this.refreshSub.dispose();
    this._onDidChange.dispose();
    if (this.ownsDriver) this.driver.dispose();
  }
}

function makeVaultData(index: VaultIndex): VaultData {
  const notes = [
    ...new Set(index.getAllNotes().map((note) => note.name).filter((name) => name.length > 0)),
  ].sort();
  return { notes, tags: index.getAllTags() };
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function yieldImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isExcluded(uri: vscode.Uri): boolean {
  return /[/\\](node_modules|\.git)[/\\]/.test(uri.path);
}

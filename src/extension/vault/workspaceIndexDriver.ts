import { WorkspaceIndexScanQueue } from "./workspaceIndexScanQueue";
// Workspace Index Driver · shared VS Code host plumbing for path-based indexes.
//
// FileSystemWatcher and VS Code file-operation events are treated only as
// invalidation hints. Leaf changes patch the snapshot; directory hints search
// only that subtree. Explicit reconciliation searches a root. All updates are
// coalesced during a build and atomically swap the root snapshot.

import * as vscode from "vscode";
import { homedir } from "node:os";
import { DEFAULT_INDEX_EXCLUDES, WorkspaceIndexExclusions } from "./workspaceIndexExclusions";
import {
  decideEnsureFresh,
  DEFAULT_MAX_FILES,
  deletionAffectsIndex,
  directoriesHoldingFiles,
  mergeRefreshInvalidation,
  kindForLeafPath,
  refreshModeForFileEvent,
  routeCreatedPath,
  routeUnavailablePath,
  WorkspaceIndexGenerationClock,
  type IndexFreshnessState,
  type IndexSnapshotStatus,
  type RefreshInvalidationBatch,
  type WorkspaceIndexRefreshMode,
} from "./workspaceIndexPolicy";

export type WorkspaceIndexKind = "image" | "note";

export interface WorkspaceIndexRefreshEvent {
  kind: WorkspaceIndexKind;
  root: vscode.Uri;
  version: number;
  reason: string;
  mode: WorkspaceIndexRefreshMode;
  changedUris: readonly vscode.Uri[];
}

export interface WorkspaceIndexBuildContext {
  generation: number;
  isCurrent: () => boolean;
  yieldNow: () => Promise<void>;
}

export class WorkspaceIndexBuildCancelled extends Error {
  constructor() {
    super("Workspace index build cancelled");
    this.name = "WorkspaceIndexBuildCancelled";
  }
}

export interface WorkspaceIndexSpec<TSnapshot> {
  kind: WorkspaceIndexKind;
  include: string;
  exclude?: string;
  debounceMs?: number;
  watchContent?: boolean;
  maxFiles?: () => number | undefined;
  notReady: () => TSnapshot;
  disabled?: (root: vscode.Uri) => TSnapshot;
  build: (
    root: vscode.Uri,
    files: readonly vscode.Uri[],
    context: WorkspaceIndexBuildContext
  ) => Promise<TSnapshot>;
  patchSnapshot?: (
    root: vscode.Uri,
    snapshot: TSnapshot,
    changedUris: readonly vscode.Uri[],
    context: WorkspaceIndexBuildContext,
    deletedUris?: readonly vscode.Uri[]
  ) => Promise<TSnapshot | undefined>;
}

export interface WorkspaceIndexHandle<TSnapshot> {
  readonly kind: WorkspaceIndexKind;
  snapshot(root: vscode.Uri): TSnapshot | undefined;
  snapshots(): readonly { root: vscode.Uri; snapshot: TSnapshot; version: number }[];
  version(root: vscode.Uri): number;
  requestRefresh(root: vscode.Uri, reason: string, immediate?: boolean): void;
  ensureFreshForDocument(documentUri: vscode.Uri, reason: string): void;
}

type RegisteredSpec = WorkspaceIndexSpec<unknown>;

interface RuntimeState extends IndexFreshnessState {
  status: IndexSnapshotStatus;
  inFlightGeneration: number | undefined;
  lastFullScanAt?: number;
  capped?: boolean;
}

const TREE_EVENT_DEBOUNCE_MS = 50;
const FULL_RESCAN_INTERVAL_MS = 30_000;

/** VS Code can preserve /C:/ on a workspace root but return /c:/ from findFiles.
 *  Canonicalize only the drive letter; directory and filename case must survive. */
function indexComparisonPath(uri: vscode.Uri): string {
  return uri.scheme === "file"
    ? uri.path.replace(/^\/[A-Z]:(?=\/)/, (drive) => drive.toLowerCase())
    : uri.path;
}

/** Strip a folder's path prefix off a contained file Uri -> root-relative path.
 *  Requires a path-segment boundary so root `/a/b` never matches `/a/bc/x`. */
export function relFromRoot(root: vscode.Uri, file: vscode.Uri): string {
  const rootPath = indexComparisonPath(root);
  const base = rootPath.endsWith("/") ? rootPath : rootPath + "/";
  return indexComparisonPath(file).startsWith(base)
    ? file.path.slice(base.length)
    : file.path.replace(/^\/+/, "");
}

export class WorkspaceIndexDriver implements vscode.Disposable {
  private readonly specs = new Map<WorkspaceIndexKind, RegisteredSpec>();
  private readonly snapshots = new Map<WorkspaceIndexKind, Map<string, unknown>>();
  private readonly versions = new Map<WorkspaceIndexKind, Map<string, number>>();
  private readonly roots = new Map<string, vscode.Uri>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly fullRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string, RefreshInvalidationBatch>();
  private readonly pendingUris = new Map<string, Map<string, vscode.Uri>>();
  private readonly generations = new WorkspaceIndexGenerationClock();
  private readonly runtime = new Map<string, RuntimeState>();
  private readonly scanQueue = new WorkspaceIndexScanQueue();
  private readonly indexedDirs = new Map<string, Set<string>>();
  private readonly indexedFiles = new Map<string, Map<string, vscode.Uri>>();
  private readonly exclusions = new Map<string, WorkspaceIndexExclusions>();
  private readonly notifiedRoots = new Set<string>();
  private readonly scanCancellations = new Map<string, vscode.CancellationTokenSource>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<WorkspaceIndexRefreshEvent>();
  private initializePromise: Promise<void> | undefined;
  private initialized = false;
  private disposed = false;

  readonly onDidRefresh = this.emitter.event;

  registerSpec<TSnapshot>(
    spec: WorkspaceIndexSpec<TSnapshot>
  ): WorkspaceIndexHandle<TSnapshot> {
    if (this.specs.has(spec.kind)) {
      throw new Error(`Workspace index spec already registered: ${spec.kind}`);
    }
    this.specs.set(spec.kind, spec as WorkspaceIndexSpec<unknown>);
    this.snapshots.set(spec.kind, new Map());
    this.versions.set(spec.kind, new Map());

    for (const root of this.roots.values()) {
      this.setSnapshot(spec.kind, root, spec.notReady(), 0);
      if (this.initialized) {
        this.requestRefresh(spec.kind, root, "spec-registered", true, true);
      }
    }

    return {
      kind: spec.kind,
      snapshot: (root: vscode.Uri): TSnapshot | undefined =>
        this.snapshots.get(spec.kind)?.get(root.toString()) as TSnapshot | undefined,
      snapshots: (): readonly { root: vscode.Uri; snapshot: TSnapshot; version: number }[] => {
        const out: { root: vscode.Uri; snapshot: TSnapshot; version: number }[] = [];
        const byRoot = this.snapshots.get(spec.kind);
        const versions = this.versions.get(spec.kind);
        if (!byRoot) return out;
        for (const [rootKey, snapshot] of byRoot) {
          const root = this.roots.get(rootKey);
          if (!root) continue;
          out.push({
            root,
            snapshot: snapshot as TSnapshot,
            version: versions?.get(rootKey) ?? 0,
          });
        }
        return out;
      },
      version: (root: vscode.Uri): number =>
        this.versions.get(spec.kind)?.get(root.toString()) ?? 0,
      requestRefresh: (root: vscode.Uri, reason: string, immediate = false): void =>
        this.requestRefresh(spec.kind, root, reason, immediate, true),
      ensureFreshForDocument: (documentUri: vscode.Uri, reason: string): void => {
        const folder = vscode.workspace.getWorkspaceFolder(documentUri);
        if (folder) this.ensureFresh(spec.kind, folder.uri, reason);
      },
    };
  }

  async initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.initializeOnce();
    return this.initializePromise;
  }

  private async initializeOnce(): Promise<void> {
    this.registerEventSources();
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) this.addRoot(f.uri);
    this.initialized = true;
    const scans: Promise<void>[] = [];
    for (const root of this.roots.values()) {
      for (const kind of this.specs.keys()) {
        const generation = this.invalidate(kind, root);
        scans.push(
          this.rescan(kind, root, "initial-scan", generation, {
            mode: "full",
            paths: new Set(),
          })
        );
      }
    }
    await Promise.all(scans);
  }

  private registerEventSources(): void {
    // Broad create/delete watcher: catches directory-level operations that do
    // not match leaf globs such as `**/*.png` or `**/*.md`.
    const treeWatcher = vscode.workspace.createFileSystemWatcher(
      "**/*",
      false,
      true,
      false
    );
    treeWatcher.onDidCreate((uri) => void this.routeCreatedUri(uri, "tree-create"));
    treeWatcher.onDidDelete((uri) => this.routeUnavailableUri(uri, "tree-delete"));
    this.disposables.push(treeWatcher);

    for (const spec of this.specs.values()) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        spec.include,
        false,
        !spec.watchContent,
        false
      );
      watcher.onDidCreate((uri) =>
        this.scheduleForUri(
          spec.kind,
          uri,
          "kind-create",
          refreshModeForFileEvent("create")
        )
      );
      watcher.onDidDelete((uri) =>
        this.scheduleForUri(
          spec.kind,
          uri,
          "kind-delete",
          refreshModeForFileEvent("delete")
        )
      );
      if (spec.watchContent) {
        watcher.onDidChange((uri) =>
          this.scheduleForUri(
            spec.kind,
            uri,
            "kind-change",
            refreshModeForFileEvent("change")
          )
        );
      }
      this.disposables.push(watcher);
    }

    this.disposables.push(
      vscode.workspace.onDidRenameFiles((event) => {
        for (const f of event.files) {
          this.routeUnavailableUri(f.oldUri, "rename-old");
          void this.routeCreatedUri(f.newUri, "rename-new");
        }
      }),
      vscode.workspace.onDidCreateFiles((event) => {
        for (const uri of event.files) void this.routeCreatedUri(uri, "operation-create");
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        for (const uri of event.files) this.routeUnavailableUri(uri, "operation-delete");
      }),
      vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        for (const f of event.removed) this.removeRoot(f.uri);
        for (const f of event.added) {
          this.addRoot(f.uri);
          this.requestAll(f.uri, "workspace-folder-added", true);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!["ofm.workspaceIndex.exclude", "files.watcherExclude", "search.exclude"].some((section) =>
          event.affectsConfiguration(section))) return;
        this.exclusions.clear();
        for (const root of this.roots.values()) this.requestAll(root, "exclusions-changed", false);
      })
    );
  }

  private addRoot(root: vscode.Uri): void {
    const key = root.toString();
    this.roots.set(key, root);
    if (root.scheme === "file" && indexComparisonPath(root).replace(/\/$/, "") ===
        indexComparisonPath(vscode.Uri.file(homedir())).replace(/\/$/, "")) {
      this.notifyLargeRoot(root, "Indexing your home folder can be expensive.");
    }
    for (const spec of this.specs.values()) {
      const byRoot = this.snapshots.get(spec.kind);
      if (!byRoot?.has(key)) this.setSnapshot(spec.kind, root, spec.notReady(), 0);
    }
  }

  private removeRoot(root: vscode.Uri): void {
    const key = root.toString();
    this.roots.delete(key);
    for (const kind of this.specs.keys()) {
      this.snapshots.get(kind)?.delete(key);
      this.versions.get(kind)?.delete(key);
      const timerKey = this.timerKey(kind, key);
      const timer = this.timers.get(timerKey);
      if (timer) clearTimeout(timer);
      this.timers.delete(timerKey);
      const fullTimer = this.fullRefreshTimers.get(timerKey);
      if (fullTimer) clearTimeout(fullTimer);
      this.fullRefreshTimers.delete(timerKey);
      this.generations.invalidate(timerKey);
      this.cancelScan(timerKey);
      this.indexedDirs.delete(timerKey);
      this.indexedFiles.delete(timerKey);
      this.exclusions.delete(timerKey);
      this.runtime.delete(timerKey);
      this.pending.delete(timerKey);
      this.pendingUris.delete(timerKey);
    }
  }

  private scheduleForUri(
    kind: WorkspaceIndexKind,
    uri: vscode.Uri,
    reason: string,
    mode: WorkspaceIndexRefreshMode = "paths"
  ): void {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    if (this.exclusionPolicy(kind, folder.uri).excludes(relFromRoot(folder.uri, uri))) return;
    this.requestRefresh(kind, folder.uri, reason, false, true, mode, uri);
  }

  private scheduleAllForUri(uri: vscode.Uri, reason: string): void {
    for (const kind of this.specs.keys()) this.scheduleForUri(kind, uri, reason);
  }

  private requestAll(root: vscode.Uri, reason: string, immediate: boolean): void {
    for (const kind of this.specs.keys()) {
      this.requestRefresh(kind, root, reason, immediate, true);
    }
  }

  private requestRefresh(
    kind: WorkspaceIndexKind,
    root: vscode.Uri,
    reason: string,
    immediate: boolean,
    markDirty: boolean,
    mode: WorkspaceIndexRefreshMode = "full",
    changedUri?: vscode.Uri
  ): void {
    if (this.disposed) return;
    this.addRoot(root);
    const spec = this.specs.get(kind);
    if (!spec) return;
    const rootKey = root.toString();
    const timerKey = this.timerKey(kind, rootKey);
    const state = this.runtimeState(kind, root);
    if (mode === "full" && state.lastFullScanAt !== undefined) {
      const remaining = state.lastFullScanAt + FULL_RESCAN_INTERVAL_MS - Date.now();
      if (remaining > 0) {
        if (!this.fullRefreshTimers.has(timerKey)) {
          this.fullRefreshTimers.set(timerKey, setTimeout(() => {
            this.fullRefreshTimers.delete(timerKey);
            this.requestRefresh(kind, root, reason, true, markDirty);
          }, remaining));
        }
        return;
      }
    }
    if (markDirty) state.dirtyEpoch++;
    const queuedMode = mode;
    this.pending.set(
      timerKey,
      mergeRefreshInvalidation(
        this.pending.get(timerKey),
        queuedMode,
        queuedMode !== "full" ? changedUri?.toString() : undefined
      )
    );
    if (queuedMode !== "full" && changedUri && this.pending.get(timerKey)?.mode !== "full") {
      const uris = this.pendingUris.get(timerKey) ?? new Map<string, vscode.Uri>();
      uris.set(changedUri.toString(), changedUri);
      this.pendingUris.set(timerKey, uris);
    } else if (this.pending.get(timerKey)?.mode === "full") {
      this.pendingUris.delete(timerKey);
    }
    // Queue hints without superseding a running build. Keep the first timer
    // too: continuous activity must not postpone publication indefinitely.
    if (stateIsBuilding(state) || this.timers.has(timerKey)) return;
    const delay = immediate ? 0 : spec.debounceMs ?? TREE_EVENT_DEBOUNCE_MS;
    this.timers.set(
      timerKey,
      setTimeout(() => {
        this.timers.delete(timerKey);
        if (stateIsBuilding(this.runtimeState(kind, root))) return;
        const batch = this.pending.get(timerKey) ?? { mode: "full", paths: new Set<string>() };
        const uris = this.pendingUris.get(timerKey);
        this.pending.delete(timerKey);
        this.pendingUris.delete(timerKey);
        const generation = this.bumpGeneration(timerKey);
        void this.rescan(kind, root, reason, generation, batch, uris);
      }, delay)
    );
  }

  private ensureFresh(kind: WorkspaceIndexKind, root: vscode.Uri, reason: string): void {
    if (this.disposed) return;
    this.addRoot(root);
    const state = this.runtimeState(kind, root);
    if (state.capped) return;
    const decision = decideEnsureFresh(state, Date.now(), reason);
    if (decision === "skip" || decision === "dedupe") return;
    // Forced requests received during a build join one follow-up.
    this.requestRefresh(kind, root, reason, false, true);
  }

  private async rescan(
    kind: WorkspaceIndexKind,
    root: vscode.Uri,
    reason: string,
    generation: number,
    batch: RefreshInvalidationBatch,
    batchUris?: ReadonlyMap<string, vscode.Uri>
  ): Promise<void> {
    const key = this.timerKey(kind, root.toString());
    try {
      await this.scanQueue.run(
        key,
        () => !this.disposed && this.roots.has(root.toString()) &&
          this.generations.isCurrent(key, generation),
        () => this.buildSnapshot(kind, root, reason, generation, batch, batchUris)
      );
    } finally {
      if (!this.disposed && this.roots.has(root.toString()) &&
          !stateIsBuilding(this.runtimeState(kind, root)) &&
          this.pending.has(key)) {
        const pending = this.pending.get(key)!;
        this.requestRefresh(kind, root, "deferred-events", false, false, pending.mode);
      }
    }
  }

  private async buildSnapshot(
    kind: WorkspaceIndexKind,
    root: vscode.Uri,
    reason: string,
    myGen: number,
    batch: RefreshInvalidationBatch,
    batchUris?: ReadonlyMap<string, vscode.Uri>
  ): Promise<void> {
    const spec = this.specs.get(kind);
    if (!spec) return;

    const rootKey = root.toString();
    const scanKey = this.timerKey(kind, rootKey);
    const state = this.runtimeState(kind, root);
    const startedEpoch = state.dirtyEpoch;
    state.status = "building";
    state.inFlight = true;
    state.inFlightGeneration = myGen;
    const isCurrent = (): boolean =>
      !this.disposed &&
      this.generations.isCurrent(scanKey, myGen) &&
      this.roots.has(rootKey);

    let snapshot: unknown;
    let completedMode: WorkspaceIndexRefreshMode = batch.mode;
    let changedUris: readonly vscode.Uri[] = [];
    let scannedFiles: readonly vscode.Uri[] | undefined;
    try {
      const context: WorkspaceIndexBuildContext = {
        generation: myGen,
        isCurrent,
        yieldNow: yieldImmediate,
      };
      if (batch.mode === "paths" && this.indexedFiles.has(scanKey)) {
        const files = new Map(this.indexedFiles.get(scanKey));
        const updated = new Map<string, vscode.Uri>();
        const removed = new Map<string, vscode.Uri>();
        const cap = spec.maxFiles?.() ?? DEFAULT_MAX_FILES;
        for (const uri of batchUris?.values() ?? []) {
          const path = indexComparisonPath(uri);
          // Remove both the leaf and its old descendants, even if a directory
          // was replaced by a file (or vice versa) between notifications.
          for (const [key, old] of files) {
            if (key === path || key.startsWith(path + "/")) {
              removed.set(key, old);
              updated.delete(key);
              files.delete(key);
            }
          }
          let stat: vscode.FileStat;
          try {
            stat = await vscode.workspace.fs.stat(uri);
          } catch (error) {
            if ((error as { code?: string }).code === "FileNotFound" ||
                (error as { code?: string }).code === "ENOENT") continue;
            throw error;
          }
          const found = (stat.type & vscode.FileType.Directory) !== 0
            ? await vscode.workspace.findFiles(new vscode.RelativePattern(uri, spec.include), this.exclusionPolicy(kind, root).glob, cap + 1)
            : kindForLeafPath(uri.path) === kind ? [uri] : [];
          for (const file of found) {
            if (this.exclusionPolicy(kind, root).excludes(relFromRoot(root, file))) continue;
            const key = indexComparisonPath(file);
            if (!files.has(key) && files.size >= cap) {
              state.capped = true;
              this.notifyLargeRoot(root, `The workspace index reached its ${cap}-file limit; the partial index remains available.`);
              continue;
            }
            files.set(key, file);
            updated.set(key, file);
            removed.delete(key);
          }
        }
        changedUris = [...updated.values()];
        const current = this.snapshots.get(kind)?.get(rootKey);
        if (spec.patchSnapshot && current !== undefined) {
          snapshot = await spec.patchSnapshot(root, current, changedUris, context, [...removed.values()]);
        }
        if (snapshot === undefined) snapshot = await spec.build(root, [...files.values()], context);
        scannedFiles = [...files.values()];
      } else if (batch.mode === "content" && spec.patchSnapshot) {
        changedUris = [...batch.paths].flatMap((path) => {
          const uri = batchUris?.get(path);
          return uri ? [uri] : [];
        });
        const current = this.snapshots.get(kind)?.get(rootKey);
        if (current !== undefined && changedUris.length === batch.paths.size) {
          snapshot = await spec.patchSnapshot(root, current, changedUris, context);
        }
        if (snapshot === undefined) completedMode = "full";
      } else {
        completedMode = "full";
      }

      if (completedMode === "full") {
        if (state.lastFullScanAt !== undefined && Date.now() - state.lastFullScanAt < FULL_RESCAN_INTERVAL_MS) {
          this.requestRefresh(kind, root, "patch-fallback", false, true);
          state.status = "ready";
          state.inFlight = false;
          state.inFlightGeneration = undefined;
          return;
        }
        state.lastFullScanAt = Date.now();
        changedUris = [];
        const cap = spec.maxFiles?.() ?? DEFAULT_MAX_FILES;
        // A newer generation cancels this token, so a superseded scan stops
        // its file search instead of running on to a discarded result.
        const cancellation = new vscode.CancellationTokenSource();
        this.cancelScan(scanKey);
        this.scanCancellations.set(scanKey, cancellation);
        let files: vscode.Uri[];
        try {
          files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(root, spec.include),
            this.exclusionPolicy(kind, root).glob,
            cap + 1,
            cancellation.token
          );
        } finally {
          if (this.scanCancellations.get(scanKey) === cancellation) {
            this.scanCancellations.delete(scanKey);
          }
          cancellation.dispose();
        }
        files = files.filter((file) => !this.exclusionPolicy(kind, root).excludes(relFromRoot(root, file)));
        if (!isCurrent()) throw new WorkspaceIndexBuildCancelled();
        state.capped = files.length >= cap;
        if (state.capped) {
          this.notifyLargeRoot(root, `The workspace index reached its ${cap}-file limit; the partial index remains available.`);
        }
        scannedFiles = files.slice(0, cap);
        snapshot = await spec.build(root, scannedFiles, context);
      }
    } catch (error) {
      if (!isCurrent() || error instanceof WorkspaceIndexBuildCancelled) {
        if (state.inFlightGeneration === myGen) {
          state.status = "cancelled";
          state.inFlight = false;
          state.inFlightGeneration = undefined;
        }
        return;
      }
      state.status = "failed";
      state.inFlight = false;
      state.inFlightGeneration = undefined;
      return;
    }

    if (!isCurrent()) {
      if (state.inFlightGeneration === myGen) {
        state.status = "cancelled";
        state.inFlight = false;
        state.inFlightGeneration = undefined;
      }
      return;
    }
    const version = this.bumpVersion(kind, root);
    this.setSnapshot(kind, root, snapshot, version);
    if (completedMode === "full") this.indexedDirs.delete(scanKey);
    if (scannedFiles) {
      this.indexedFiles.set(scanKey, new Map(scannedFiles.map((file) => [indexComparisonPath(file), file])));
      this.indexedDirs.set(
        scanKey,
        directoriesHoldingFiles(scannedFiles.map(indexComparisonPath), indexComparisonPath(root))
      );
    }
    state.status = "ready";
    state.lastSuccessAt = Date.now();
    state.completedEpoch = startedEpoch;
    state.inFlight = false;
    state.inFlightGeneration = undefined;
    this.emitter.fire({ kind, root, version, reason, mode: completedMode, changedUris });
  }

  /** Route a path whose current type can be inspected. Known leaf files only
   * invalidate their own index; directories and stat failures are tree events. */
  private async routeCreatedUri(uri: vscode.Uri, reason: string): Promise<void> {
    if (this.excludedForAll(uri)) return;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const type = (stat.type & vscode.FileType.Directory) !== 0 ? "directory" : "file";
      this.applyTreeRoute(uri, reason, routeCreatedPath(uri.path, type));
    } catch {
      // A fast-created temporary file may be gone before stat completes.
      // Reuse unavailable-path routing instead of rebuilding both indexes.
      this.routeUnavailableUri(uri, reason + "-unavailable");
    }
  }

  /** Deleted/old paths cannot be stat'ed. A recognized target extension is a
   * known leaf event; every ambiguous path conservatively invalidates both. */
  private routeUnavailableUri(uri: vscode.Uri, reason: string): void {
    if (this.excludedForAll(uri)) return;
    const route = routeUnavailablePath(uri.path);
    const comparisonPath = indexComparisonPath(uri);
    if (route === "ignore") return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    for (const kind of this.specs.keys()) {
      const key = this.timerKey(kind, folder.uri.toString());
      const dirs = this.indexedDirs.get(key);
      // Let the first search finish once so unrelated temp-file deletions
      // cannot repeatedly cancel initialization before directory routing exists.
      if (route === "all" && dirs === undefined &&
          stateIsBuilding(this.runtimeState(kind, folder.uri))) {
        this.scheduleForUri(kind, uri, reason);
        continue;
      }
      // A directory can itself end in .md or .png. Known indexed directories
      // must invalidate every affected index, regardless of the leaf suffix.
      if (route === kind || dirs?.has(comparisonPath) ||
          (route === "all" && deletionAffectsIndex(comparisonPath, dirs))) {
        this.scheduleForUri(kind, uri, reason);
      }
    }
  }

  private applyTreeRoute(
    uri: vscode.Uri,
    reason: string,
    route: "note" | "image" | "all" | "ignore"
  ): void {
    if (route === "all") this.scheduleAllForUri(uri, reason);
    else if (route !== "ignore") this.scheduleForUri(route, uri, reason);
  }

  private invalidate(kind: WorkspaceIndexKind, root: vscode.Uri): number {
    const state = this.runtimeState(kind, root);
    state.dirtyEpoch++;
    return this.bumpGeneration(this.timerKey(kind, root.toString()));
  }

  private excludedForAll(uri: vscode.Uri): boolean {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return !folder || [...this.specs.keys()].every((kind) =>
      this.exclusionPolicy(kind, folder.uri).excludes(relFromRoot(folder.uri, uri)));
  }

  private notifyLargeRoot(root: vscode.Uri, detail: string): void {
    const key = root.toString();
    if (this.notifiedRoots.has(key)) return;
    this.notifiedRoots.add(key);
    void vscode.window.showInformationMessage(`Flintmark: ${detail} Consider opening a narrower folder for note and image indexing.`);
  }

  private exclusionPolicy(kind: WorkspaceIndexKind, root: vscode.Uri): WorkspaceIndexExclusions {
    const key = this.timerKey(kind, root.toString());
    let policy = this.exclusions.get(key);
    if (!policy) {
      const configuration = vscode.workspace.getConfiguration(undefined, root);
      const patterns = [...configuration.get<string[]>("ofm.workspaceIndex.exclude", DEFAULT_INDEX_EXCLUDES)];
      for (const section of ["files.watcherExclude", "search.exclude"]) {
        const excludes = configuration.get<Record<string, unknown>>(section, {});
        patterns.push(...Object.keys(excludes).filter((pattern) => excludes[pattern] === true));
      }
      const specExclude = this.specs.get(kind)?.exclude;
      policy = new WorkspaceIndexExclusions(specExclude ? [...patterns, specExclude] : patterns);
      this.exclusions.set(key, policy);
    }
    return policy;
  }

  private bumpGeneration(key: string): number {
    this.cancelScan(key);
    return this.generations.bump(key);
  }

  private cancelScan(key: string): void {
    const cancellation = this.scanCancellations.get(key);
    if (!cancellation) return;
    this.scanCancellations.delete(key);
    cancellation.cancel();
  }

  private runtimeState(kind: WorkspaceIndexKind, root: vscode.Uri): RuntimeState {
    const key = this.timerKey(kind, root.toString());
    let state = this.runtime.get(key);
    if (!state) {
      state = {
        status: "notReady",
        lastSuccessAt: undefined,
        dirtyEpoch: 0,
        completedEpoch: 0,
        inFlight: false,
        inFlightGeneration: undefined,
      };
      this.runtime.set(key, state);
    }
    return state;
  }

  private setSnapshot(
    kind: WorkspaceIndexKind,
    root: vscode.Uri,
    snapshot: unknown,
    version: number
  ): void {
    const key = root.toString();
    this.snapshots.get(kind)?.set(key, snapshot);
    this.versions.get(kind)?.set(key, version);
  }

  private bumpVersion(kind: WorkspaceIndexKind, root: vscode.Uri): number {
    const byRoot = this.versions.get(kind);
    const key = root.toString();
    const next = (byRoot?.get(key) ?? 0) + 1;
    byRoot?.set(key, next);
    return next;
  }

  private timerKey(kind: WorkspaceIndexKind, rootKey: string): string {
    return `${kind}\0${rootKey}`;
  }

  dispose(): void {
    this.disposed = true;
    this.generations.invalidateAll();
    for (const key of [...this.scanCancellations.keys()]) this.cancelScan(key);
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.fullRefreshTimers.values()) clearTimeout(timer);
    this.fullRefreshTimers.clear();
    this.timers.clear();
    this.pending.clear();
    this.pendingUris.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.emitter.dispose();
  }
}

function yieldImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function stateIsBuilding(state: RuntimeState): boolean {
  return state.inFlight || state.status === "building";
}

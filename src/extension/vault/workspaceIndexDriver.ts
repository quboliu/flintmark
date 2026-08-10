// Workspace Index Driver · shared VS Code host plumbing for path-based indexes.
//
// FileSystemWatcher and VS Code file-operation events are treated only as
// invalidation hints. Structural/tree events rebuild from a per-root `findFiles`
// reconciliation; known content-only leaf changes may use a spec-provided
// copy-on-write patch. Either path atomically swaps the root snapshot.

import * as vscode from "vscode";
import {
  decideEnsureFresh,
  mergeRefreshInvalidation,
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
  overCap?: (root: vscode.Uri, cap: number) => TSnapshot;
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
    context: WorkspaceIndexBuildContext
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
}

const TREE_EVENT_DEBOUNCE_MS = 50;

/** Strip a folder's path prefix off a contained file Uri -> root-relative path.
 *  Requires a path-segment boundary so root `/a/b` never matches `/a/bc/x`. */
export function relFromRoot(root: vscode.Uri, file: vscode.Uri): string {
  const base = root.path.endsWith("/") ? root.path : root.path + "/";
  return file.path.startsWith(base)
    ? file.path.slice(base.length)
    : file.path.replace(/^\/+/, "");
}

export class WorkspaceIndexDriver implements vscode.Disposable {
  private readonly specs = new Map<WorkspaceIndexKind, RegisteredSpec>();
  private readonly snapshots = new Map<WorkspaceIndexKind, Map<string, unknown>>();
  private readonly versions = new Map<WorkspaceIndexKind, Map<string, number>>();
  private readonly roots = new Map<string, vscode.Uri>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Map<string, RefreshInvalidationBatch>();
  private readonly pendingUris = new Map<string, Map<string, vscode.Uri>>();
  private readonly generations = new WorkspaceIndexGenerationClock();
  private readonly runtime = new Map<string, RuntimeState>();
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
      })
    );
  }

  private addRoot(root: vscode.Uri): void {
    const key = root.toString();
    this.roots.set(key, root);
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
      this.generations.invalidate(timerKey);
      this.runtime.delete(timerKey);
      this.pending.delete(timerKey);
      this.pendingUris.delete(timerKey);
    }
  }

  private scheduleForUri(
    kind: WorkspaceIndexKind,
    uri: vscode.Uri,
    reason: string,
    mode: WorkspaceIndexRefreshMode = "full"
  ): void {
    if (isCommonlyExcluded(uri)) return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    this.requestRefresh(kind, folder.uri, reason, false, true, mode, mode === "content" ? uri : undefined);
  }

  private scheduleAllForUri(uri: vscode.Uri, reason: string): void {
    if (isCommonlyExcluded(uri)) return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    this.requestAll(folder.uri, reason, false);
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
    const generation = markDirty
      ? this.invalidate(kind, root)
      : this.bumpGeneration(timerKey);
    const queuedMode = mode === "content" && stateIsBuilding(this.runtimeState(kind, root))
      ? "full"
      : mode;
    this.pending.set(
      timerKey,
      mergeRefreshInvalidation(
        this.pending.get(timerKey),
        queuedMode,
        queuedMode === "content" ? changedUri?.toString() : undefined
      )
    );
    if (queuedMode === "content" && changedUri && this.pending.get(timerKey)?.mode === "content") {
      const uris = this.pendingUris.get(timerKey) ?? new Map<string, vscode.Uri>();
      uris.set(changedUri.toString(), changedUri);
      this.pendingUris.set(timerKey, uris);
    } else if (this.pending.get(timerKey)?.mode === "full") {
      this.pendingUris.delete(timerKey);
    }
    const existing = this.timers.get(timerKey);
    if (existing) clearTimeout(existing);
    const delay = immediate ? 0 : spec.debounceMs ?? TREE_EVENT_DEBOUNCE_MS;
    this.timers.set(
      timerKey,
      setTimeout(() => {
        this.timers.delete(timerKey);
        const batch = this.pending.get(timerKey) ?? { mode: "full", paths: new Set<string>() };
        const uris = this.pendingUris.get(timerKey);
        this.pending.delete(timerKey);
        this.pendingUris.delete(timerKey);
        void this.rescan(kind, root, reason, generation, batch, uris);
      }, delay)
    );
  }

  private ensureFresh(kind: WorkspaceIndexKind, root: vscode.Uri, reason: string): void {
    if (this.disposed) return;
    this.addRoot(root);
    const state = this.runtimeState(kind, root);
    const decision = decideEnsureFresh(state, Date.now(), reason);
    if (decision === "skip" || decision === "dedupe") return;
    // Forced requests received during a build invalidate it. The next scan is
    // debounced, so duplicate attachment notifications still coalesce.
    this.requestRefresh(kind, root, reason, false, true);
  }

  private async rescan(
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
    try {
      const context: WorkspaceIndexBuildContext = {
        generation: myGen,
        isCurrent,
        yieldNow: yieldImmediate,
      };
      if (batch.mode === "content" && spec.patchSnapshot) {
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
        changedUris = [];
        const cap = spec.maxFiles?.();
        const files = await vscode.workspace.findFiles(
          new vscode.RelativePattern(root, spec.include),
          spec.exclude,
          cap === undefined ? undefined : cap + 1
        );
        if (!isCurrent()) throw new WorkspaceIndexBuildCancelled();
        if (cap !== undefined && files.length > cap) {
          snapshot = spec.overCap ? spec.overCap(root, cap) : spec.notReady();
        } else {
          snapshot = await spec.build(root, files, context);
        }
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
    if (isCommonlyExcluded(uri)) return;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const type = (stat.type & vscode.FileType.Directory) !== 0 ? "directory" : "file";
      this.applyTreeRoute(uri, reason, routeCreatedPath(uri.path, type));
    } catch {
      this.applyTreeRoute(uri, reason, routeCreatedPath(uri.path, "unknown"));
    }
  }

  /** Deleted/old paths cannot be stat'ed. A recognized target extension is a
   * known leaf event; every ambiguous path conservatively invalidates both. */
  private routeUnavailableUri(uri: vscode.Uri, reason: string): void {
    if (isCommonlyExcluded(uri)) return;
    this.applyTreeRoute(uri, reason, routeUnavailablePath(uri.path));
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

  private bumpGeneration(key: string): number {
    return this.generations.bump(key);
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
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    this.pendingUris.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.emitter.dispose();
  }
}

function isCommonlyExcluded(uri: vscode.Uri): boolean {
  return /[/\\](node_modules|\.git|\.obsidian|\.trash)(?:[/\\]|$)/.test(uri.path);
}

function yieldImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function stateIsBuilding(state: RuntimeState): boolean {
  return state.inFlight || state.status === "building";
}

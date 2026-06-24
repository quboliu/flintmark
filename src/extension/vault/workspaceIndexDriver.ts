// Workspace Index Driver · shared VS Code host plumbing for path-based indexes.
//
// FileSystemWatcher and VS Code file-operation events are treated only as
// invalidation hints. A ready snapshot is always rebuilt from a per-root
// `findFiles` reconciliation and atomically swapped in. This keeps directory
// rename/move semantics local to one Module instead of duplicating fragile
// watcher assumptions in every index.

import * as vscode from "vscode";

export type WorkspaceIndexKind = "image" | "note";

export interface WorkspaceIndexRefreshEvent {
  kind: WorkspaceIndexKind;
  root: vscode.Uri;
  version: number;
  reason: string;
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
  build: (root: vscode.Uri, files: readonly vscode.Uri[]) => Promise<TSnapshot>;
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
  private readonly gen = new Map<string, number>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<WorkspaceIndexRefreshEvent>();
  private initializePromise: Promise<void> | undefined;
  private initialized = false;

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
      if (this.initialized) this.requestRefresh(spec.kind, root, "spec-registered", true);
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
        this.requestRefresh(spec.kind, root, reason, immediate),
      ensureFreshForDocument: (documentUri: vscode.Uri, reason: string): void => {
        const folder = vscode.workspace.getWorkspaceFolder(documentUri);
        if (folder) this.requestRefresh(spec.kind, folder.uri, reason, false);
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
    await Promise.all(
      [...this.roots.values()].flatMap((root) =>
        [...this.specs.keys()].map((kind) => this.rescan(kind, root, "initial-scan"))
      )
    );
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
    treeWatcher.onDidCreate((uri) => this.scheduleAllForUri(uri, "tree-create"));
    treeWatcher.onDidDelete((uri) => this.scheduleAllForUri(uri, "tree-delete"));
    this.disposables.push(treeWatcher);

    for (const spec of this.specs.values()) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        spec.include,
        false,
        !spec.watchContent,
        false
      );
      watcher.onDidCreate((uri) => this.scheduleForUri(spec.kind, uri, "kind-create"));
      watcher.onDidDelete((uri) => this.scheduleForUri(spec.kind, uri, "kind-delete"));
      if (spec.watchContent) {
        watcher.onDidChange((uri) => this.scheduleForUri(spec.kind, uri, "kind-change"));
      }
      this.disposables.push(watcher);
    }

    this.disposables.push(
      vscode.workspace.onDidRenameFiles((event) => {
        for (const f of event.files) {
          this.scheduleAllForUri(f.oldUri, "rename-old");
          this.scheduleAllForUri(f.newUri, "rename-new");
        }
      }),
      vscode.workspace.onDidCreateFiles((event) => {
        for (const uri of event.files) this.scheduleAllForUri(uri, "operation-create");
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        for (const uri of event.files) this.scheduleAllForUri(uri, "operation-delete");
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
      this.gen.delete(timerKey);
    }
  }

  private scheduleForUri(kind: WorkspaceIndexKind, uri: vscode.Uri, reason: string): void {
    if (isCommonlyExcluded(uri)) return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    this.requestRefresh(kind, folder.uri, reason, false);
  }

  private scheduleAllForUri(uri: vscode.Uri, reason: string): void {
    if (isCommonlyExcluded(uri)) return;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    this.requestAll(folder.uri, reason, false);
  }

  private requestAll(root: vscode.Uri, reason: string, immediate: boolean): void {
    for (const kind of this.specs.keys()) this.requestRefresh(kind, root, reason, immediate);
  }

  private requestRefresh(
    kind: WorkspaceIndexKind,
    root: vscode.Uri,
    reason: string,
    immediate: boolean
  ): void {
    this.addRoot(root);
    const spec = this.specs.get(kind);
    if (!spec) return;
    const rootKey = root.toString();
    const timerKey = this.timerKey(kind, rootKey);
    const existing = this.timers.get(timerKey);
    if (existing) clearTimeout(existing);
    const delay = immediate ? 0 : spec.debounceMs ?? TREE_EVENT_DEBOUNCE_MS;
    this.timers.set(
      timerKey,
      setTimeout(() => {
        this.timers.delete(timerKey);
        void this.rescan(kind, root, reason);
      }, delay)
    );
  }

  private async rescan(
    kind: WorkspaceIndexKind,
    root: vscode.Uri,
    reason: string
  ): Promise<void> {
    const spec = this.specs.get(kind);
    if (!spec) return;

    const rootKey = root.toString();
    const scanKey = this.timerKey(kind, rootKey);
    const myGen = (this.gen.get(scanKey) ?? 0) + 1;
    this.gen.set(scanKey, myGen);

    let snapshot: unknown;
    try {
      const cap = spec.maxFiles?.();
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(root, spec.include),
        spec.exclude,
        cap === undefined ? undefined : cap + 1
      );
      if (cap !== undefined && files.length > cap) {
        snapshot = spec.overCap ? spec.overCap(root, cap) : spec.notReady();
      } else {
        snapshot = await spec.build(root, files);
      }
    } catch {
      snapshot = spec.disabled ? spec.disabled(root) : spec.notReady();
    }

    if (this.gen.get(scanKey) !== myGen) return;
    const version = this.bumpVersion(kind, root);
    this.setSnapshot(kind, root, snapshot, version);
    this.emitter.fire({ kind, root, version, reason });
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
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.emitter.dispose();
  }
}

function isCommonlyExcluded(uri: vscode.Uri): boolean {
  return /[/\\](node_modules|\.git|\.obsidian|\.trash)[/\\]/.test(uri.path);
}

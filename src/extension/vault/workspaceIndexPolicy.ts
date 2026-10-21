export const DOCUMENT_READY_MAX_STALE_MS = 5_000;

export type IndexSnapshotStatus =
  | "notReady"
  | "building"
  | "ready"
  | "failed"
  | "cancelled";

export interface IndexFreshnessState {
  status: IndexSnapshotStatus;
  lastSuccessAt: number | undefined;
  dirtyEpoch: number;
  completedEpoch: number;
  inFlight: boolean;
}

export type EnsureFreshDecision =
  | "skip"
  | "dedupe"
  | "refresh"
  | "queue-after-flight";

export function isForcedRefreshReason(reason: string): boolean {
  return reason === "attachment-saved";
}

export type TreeEventRoute = "note" | "image" | "all" | "ignore";

export type WorkspaceIndexRefreshMode = "content" | "full";
export type WorkspaceFileEventKind = "change" | "create" | "delete" | "rename" | "tree";

export function refreshModeForFileEvent(
  event: WorkspaceFileEventKind
): WorkspaceIndexRefreshMode {
  return event === "change" ? "content" : "full";
}

export interface RefreshInvalidationBatch {
  mode: WorkspaceIndexRefreshMode;
  paths: Set<string>;
}

/** Per-driver generation clock. Keys intentionally live for the driver's full
 * lifetime so removing and re-adding the same workspace URI cannot ABA. */
export class WorkspaceIndexGenerationClock {
  private readonly generations = new Map<string, number>();

  bump(key: string): number {
    const next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next);
    return next;
  }

  invalidate(key: string): void {
    this.bump(key);
  }

  invalidateAll(): void {
    for (const key of this.generations.keys()) this.bump(key);
  }

  isCurrent(key: string, generation: number): boolean {
    return this.generations.get(key) === generation;
  }
}

/** Merge debounced invalidations. A single structural event permanently
 * upgrades the batch to full; content-only paths are otherwise deduplicated. */
export function mergeRefreshInvalidation(
  current: RefreshInvalidationBatch | undefined,
  mode: WorkspaceIndexRefreshMode,
  path?: string
): RefreshInvalidationBatch {
  if (current?.mode === "full" || mode === "full") {
    return { mode: "full", paths: new Set() };
  }
  const paths = new Set(current?.paths);
  if (path) paths.add(path);
  return { mode: "content", paths };
}

export function routeCreatedPath(
  path: string,
  type: "file" | "directory" | "unknown"
): TreeEventRoute {
  if (type !== "file") return "all";
  return kindForLeafPath(path) ?? "ignore";
}

export function routeUnavailablePath(path: string): TreeEventRoute {
  return kindForLeafPath(path) ?? "all";
}

/** Every directory strictly below `rootPath` that holds an indexed file,
 * directly or in a subdirectory. */
export function directoriesHoldingFiles(
  filePaths: Iterable<string>,
  rootPath: string
): Set<string> {
  const root = rootPath.endsWith("/") ? rootPath.slice(0, -1) : rootPath;
  const dirs = new Set<string>();
  for (const path of filePaths) {
    for (let dir = path.slice(0, path.lastIndexOf("/")); dir.length > root.length; ) {
      if (dirs.has(dir)) break;
      dirs.add(dir);
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }
  return dirs;
}

/** A deleted path that is not itself a note or image only matters to an index
 * whose last completed scan saw files under it. Busy workspaces delete
 * unrelated files constantly; rebuilding for each one never lets the index
 * settle. Without a completed scan, stay conservative. */
export function deletionAffectsIndex(
  path: string,
  indexedDirs: ReadonlySet<string> | undefined
): boolean {
  return indexedDirs === undefined || indexedDirs.has(path);
}

export function kindForLeafPath(path: string): "note" | "image" | undefined {
  if (/\.(md|markdown)$/i.test(path)) return "note";
  if (/\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i.test(path)) return "image";
  return undefined;
}

/** Stateful freshness gate. Freshness is measured from the latest successful
 * completion, never from the latest request, so watcher misses have a bounded
 * stale window and failures/cancellations cannot suppress reconciliation. */
export function decideEnsureFresh(
  state: IndexFreshnessState,
  now: number,
  reason: string,
  maxStaleMs = DOCUMENT_READY_MAX_STALE_MS
): EnsureFreshDecision {
  const forced = isForcedRefreshReason(reason);
  if (state.inFlight) return forced ? "queue-after-flight" : "dedupe";
  if (forced) return "refresh";
  if (state.status !== "ready") return "refresh";
  if (state.dirtyEpoch !== state.completedEpoch) return "refresh";
  if (state.lastSuccessAt === undefined) return "refresh";
  return now - state.lastSuccessAt < maxStaleMs ? "skip" : "refresh";
}

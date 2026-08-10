import assert from "node:assert";
import {
  decideEnsureFresh,
  DOCUMENT_READY_MAX_STALE_MS,
  mergeRefreshInvalidation,
  refreshModeForFileEvent,
  routeCreatedPath,
  routeUnavailablePath,
  WorkspaceIndexGenerationClock,
  type IndexFreshnessState,
} from "../../src/extension/vault/workspaceIndexPolicy";

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log("  ✓ " + name);
  } catch (error) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (error as Error).message);
  }
}

const ready: IndexFreshnessState = {
  status: "ready",
  lastSuccessAt: 10_000,
  dirtyEpoch: 4,
  completedEpoch: 4,
  inFlight: false,
};

test("document-ready skips only a clean, successful, sufficiently fresh snapshot", () => {
  assert.equal(decideEnsureFresh(ready, 10_100, "webview-ready"), "skip");
  assert.equal(
    decideEnsureFresh(ready, 10_000 + DOCUMENT_READY_MAX_STALE_MS, "webview-ready"),
    "refresh",
    "the stale-window boundary must reconcile watcher misses"
  );
  assert.equal(
    decideEnsureFresh({ ...ready, dirtyEpoch: 5 }, 10_100, "webview-ready"),
    "refresh"
  );
  assert.equal(
    decideEnsureFresh({ ...ready, status: "failed" }, 10_100, "webview-ready"),
    "refresh"
  );
});

test("attachment-saved bypasses freshness throttling", () => {
  assert.equal(decideEnsureFresh(ready, 10_001, "attachment-saved"), "refresh");
});

test("in-flight requests dedupe, while forced refresh queues one follow-up", () => {
  const building: IndexFreshnessState = { ...ready, status: "building", inFlight: true };
  assert.equal(decideEnsureFresh(building, 10_100, "webview-ready"), "dedupe");
  assert.equal(
    decideEnsureFresh(building, 10_100, "attachment-saved"),
    "queue-after-flight"
  );
});

test("tree events route known leaves narrowly and ambiguous trees to both specs", () => {
  assert.equal(routeCreatedPath("/vault/note.markdown", "file"), "note");
  assert.equal(routeCreatedPath("/vault/image.SVG", "file"), "image");
  assert.equal(routeCreatedPath("/vault/cache.txt", "file"), "ignore");
  assert.equal(routeCreatedPath("/vault/mixed.md", "directory"), "all");
  assert.equal(routeCreatedPath("/vault/moved-tree", "unknown"), "all");
  assert.equal(routeUnavailablePath("/vault/deleted.md"), "note");
  assert.equal(routeUnavailablePath("/vault/deleted.png"), "image");
  assert.equal(routeUnavailablePath("/vault/deleted-tree"), "all");
});

test("content invalidations coalesce changed paths without becoming structural", () => {
  let batch = mergeRefreshInvalidation(undefined, "content", "file:///vault/A.md");
  batch = mergeRefreshInvalidation(batch, "content", "file:///vault/B.md");
  batch = mergeRefreshInvalidation(batch, "content", "file:///vault/A.md");
  assert.equal(batch.mode, "content");
  assert.deepEqual([...batch.paths].sort(), ["file:///vault/A.md", "file:///vault/B.md"]);
});

test("one structural invalidation upgrades the whole batch and cannot downgrade", () => {
  let batch = mergeRefreshInvalidation(undefined, "content", "file:///vault/A.md");
  batch = mergeRefreshInvalidation(batch, "full");
  batch = mergeRefreshInvalidation(batch, "content", "file:///vault/B.md");
  assert.equal(batch.mode, "full");
  assert.equal(batch.paths.size, 0);
});

test("only a known leaf content change is incremental; every structural cause is full", () => {
  assert.equal(refreshModeForFileEvent("change"), "content");
  for (const event of ["create", "delete", "rename", "tree"] as const) {
    assert.equal(refreshModeForFileEvent(event), "full", event);
  }
});

test("remove and same-URI re-add cannot let a deferred old build publish", () => {
  const clock = new WorkspaceIndexGenerationClock();
  const key = "note\0file:///vault";
  let published = "";
  const oldBuild = clock.bump(key);
  const finishOldBuild = (): void => {
    if (clock.isCurrent(key, oldBuild)) published = "old";
  };

  clock.invalidate(key); // workspace root removed
  const newBuild = clock.bump(key); // same URI re-added
  if (clock.isCurrent(key, newBuild)) published = "new";
  finishOldBuild(); // deferred old build completes last

  assert.equal(published, "new");
  assert.notEqual(oldBuild, newBuild, "generation must not ABA across root incarnations");
});

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll workspace-index policy tests passed");

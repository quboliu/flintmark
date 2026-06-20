// Image/attachment index · thin VS Code adapter (MAY import vscode).
//
// Per workspace ROOT, it builds a PATH-ONLY snapshot of image files (no bytes
// read) so the editor hot path can resolve `![[img.png]]` / `![](img.png)`
// SYNCHRONOUSLY (see imageResolver.ts). Async work is confined to the initial
// build and the FileSystemWatcher-driven rescans; resolution itself never does
// I/O. On any (re)build it fires onDidChange so the provider can refresh open
// panels. In any non-"ready" state the provider falls back to legacy
// document-relative resolution (no regression for same-folder images).

import * as vscode from "vscode";
import {
  buildSnapshot,
  resolveImageRef,
  ImageSnapshot,
} from "./imageResolver";

const IMAGE_GLOB = "**/*.{png,jpg,jpeg,gif,svg,webp,bmp,avif}";
const EXCLUDE_GLOB = "**/{.git,node_modules,.obsidian,.trash}/**";
const RESCAN_DEBOUNCE_MS = 150;
const DEFAULT_MAX_FILES = 100_000;

/** Strip a folder's path prefix off a contained file Uri → root-relative path. */
function relFromRoot(root: vscode.Uri, file: vscode.Uri): string {
  const rp = file.path.startsWith(root.path)
    ? file.path.slice(root.path.length)
    : file.path;
  return rp.replace(/^\/+/, "");
}

export class ImageIndexService implements vscode.Disposable {
  /** rootUri.toString() → immutable snapshot. */
  private readonly snapshots = new Map<string, ImageSnapshot>();
  /** rootUri.toString() → root Uri (for building resolved Uris). */
  private readonly roots = new Map<string, vscode.Uri>();
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly rescanTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly emitter = new vscode.EventEmitter<void>();

  /** Fires after any root's snapshot is (re)built. */
  readonly onDidChange = this.emitter.event;

  private maxFiles(): number {
    return (
      vscode.workspace.getConfiguration("ofm").get<number>("imageIndex.maxFiles") ??
      DEFAULT_MAX_FILES
    );
  }

  /** Scan all workspace roots and start watching. Non-blocking at activation. */
  async initialize(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) {
      this.roots.set(f.uri.toString(), f.uri);
      this.snapshots.set(f.uri.toString(), buildSnapshot([], "notReady"));
    }
    await Promise.all(folders.map((f) => this.rescanRoot(f.uri)));

    this.watcher = vscode.workspace.createFileSystemWatcher(IMAGE_GLOB);
    const touch = (uri: vscode.Uri): void => this.onImageChanged(uri);
    this.watcher.onDidCreate(touch);
    this.watcher.onDidDelete(touch);
    // onDidChange (content) does not affect the path index — ignored on purpose.
  }

  /**
   * Resolve a raw image ref for a document to a file Uri inside its workspace
   * root, or null (caller falls back to legacy doc-relative). SYNCHRONOUS.
   */
  resolveImage(
    documentUri: vscode.Uri,
    rawPath: string,
    requireImageExt: boolean
  ): vscode.Uri | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(documentUri);
    if (!folder) return undefined; // single-file / outside any root → legacy
    const snap = this.snapshots.get(folder.uri.toString());
    if (!snap) return undefined;
    const docRel = relFromRoot(folder.uri, documentUri);
    const docDir = docRel.split("/").slice(0, -1).filter((s) => s.length > 0);
    const entry = resolveImageRef(snap, docDir, rawPath, requireImageExt);
    if (!entry) return undefined;
    return vscode.Uri.joinPath(folder.uri, ...entry.segments);
  }

  // ----- internals -------------------------------------------------------

  private onImageChanged(uri: vscode.Uri): void {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return;
    this.scheduleRescan(folder.uri);
  }

  private scheduleRescan(root: vscode.Uri): void {
    const key = root.toString();
    const existing = this.rescanTimers.get(key);
    if (existing) clearTimeout(existing);
    this.rescanTimers.set(
      key,
      setTimeout(() => {
        this.rescanTimers.delete(key);
        void this.rescanRoot(root);
      }, RESCAN_DEBOUNCE_MS)
    );
  }

  /** Full rescan of one root → atomically swap in a new snapshot → emit once. */
  private async rescanRoot(root: vscode.Uri): Promise<void> {
    this.roots.set(root.toString(), root);
    const cap = this.maxFiles();
    let snapshot: ImageSnapshot;
    try {
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(root, IMAGE_GLOB),
        EXCLUDE_GLOB,
        cap + 1
      );
      if (found.length > cap) {
        console.warn(
          `[ofm] image index: ${root.fsPath} has > ${cap} images — vault-wide image resolution disabled for this root (configurable via ofm.imageIndex.maxFiles).`
        );
        snapshot = buildSnapshot([], "overCap");
      } else {
        snapshot = buildSnapshot(found.map((u) => relFromRoot(root, u)));
      }
    } catch {
      snapshot = buildSnapshot([], "disabled");
    }
    this.snapshots.set(root.toString(), snapshot);
    this.emitter.fire();
  }

  dispose(): void {
    for (const t of this.rescanTimers.values()) clearTimeout(t);
    this.rescanTimers.clear();
    this.watcher?.dispose();
    this.emitter.dispose();
  }
}

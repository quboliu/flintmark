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
import {
  relFromRoot,
  WorkspaceIndexDriver,
  type WorkspaceIndexHandle,
} from "./workspaceIndexDriver";

const IMAGE_GLOB = "**/*.{png,jpg,jpeg,gif,svg,webp,bmp,avif}";
const EXCLUDE_GLOB = "**/{.git,node_modules,.obsidian,.trash}/**";
const RESCAN_DEBOUNCE_MS = 150;
const DEFAULT_MAX_FILES = 100_000;

export class ImageIndexService implements vscode.Disposable {
  private readonly driver: WorkspaceIndexDriver;
  private readonly ownsDriver: boolean;
  private readonly handle: WorkspaceIndexHandle<ImageSnapshot>;
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly refreshSub: vscode.Disposable;

  /** Fires after any root's snapshot is (re)built. */
  readonly onDidChange = this.emitter.event;

  constructor(driver?: WorkspaceIndexDriver) {
    this.driver = driver ?? new WorkspaceIndexDriver();
    this.ownsDriver = driver === undefined;
    this.handle = this.driver.registerSpec<ImageSnapshot>({
      kind: "image",
      include: IMAGE_GLOB,
      exclude: EXCLUDE_GLOB,
      debounceMs: RESCAN_DEBOUNCE_MS,
      // Content changes do not alter the path index, but a refresh event lets
      // open webviews re-request image URIs if the host reports a replacement.
      watchContent: true,
      maxFiles: () => this.maxFiles(),
      notReady: () => buildSnapshot([], "notReady"),
      overCap: (root, cap) => {
        console.warn(
          `[ofm] image index: ${root.fsPath} has > ${cap} images — vault-wide image resolution disabled for this root (configurable via ofm.imageIndex.maxFiles).`
        );
        return buildSnapshot([], "overCap");
      },
      disabled: () => buildSnapshot([], "disabled"),
      build: async (root, files) =>
        buildSnapshot(files.map((u) => relFromRoot(root, u))),
    });
    this.refreshSub = this.driver.onDidRefresh((event) => {
      if (event.kind === "image") this.emitter.fire();
    });
  }

  private maxFiles(): number {
    return (
      vscode.workspace.getConfiguration("ofm").get<number>("imageIndex.maxFiles") ??
      DEFAULT_MAX_FILES
    );
  }

  /** Scan all workspace roots and start watching. Non-blocking at activation. */
  async initialize(): Promise<void> {
    await this.driver.initialize();
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
    const snap = this.handle.snapshot(folder.uri);
    if (!snap) return undefined;
    const docRel = relFromRoot(folder.uri, documentUri);
    const docDir = docRel.split("/").slice(0, -1).filter((s) => s.length > 0);
    const entry = resolveImageRef(snap, docDir, rawPath, requireImageExt);
    if (!entry) return undefined;
    const uri = vscode.Uri.joinPath(folder.uri, ...entry.segments);
    const version = this.handle.version(folder.uri);
    return version > 0 ? uri.with({ query: `ofmIndex=${version}` }) : uri;
  }

  /** Open/ready documents ask for a fresh reconciliation asynchronously. This
   *  covers external directory moves or bulk creates that watchers may fold or
   *  miss; resolution itself remains synchronous and I/O-free. */
  ensureFreshForDocument(documentUri: vscode.Uri, reason = "document-ready"): void {
    this.handle.ensureFreshForDocument(documentUri, reason);
  }

  dispose(): void {
    this.refreshSub.dispose();
    this.emitter.dispose();
    if (this.ownsDriver) this.driver.dispose();
  }
}

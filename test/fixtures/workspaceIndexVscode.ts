// Minimal host boundary for WorkspaceIndexDriver tests. Only this test opts in
// to the alias; all routing, scheduling, scans, and snapshots use production code.
export class Disposable {
  constructor(private readonly fn = () => {}) {}
  dispose() { this.fn(); }
}
export class EventEmitter<T> {
  private readonly listeners = new Set<(event: T) => void>();
  readonly event = (listener: (event: T) => void) => {
    this.listeners.add(listener);
    return new Disposable(() => { this.listeners.delete(listener); });
  };
  fire(event: T) { for (const listener of this.listeners) listener(event); }
  dispose() { this.listeners.clear(); }
}
export class CancellationTokenSource {
  readonly token = { isCancellationRequested: false };
  cancel() { this.token.isCancellationRequested = true; }
  dispose() {}
}
export class RelativePattern {
  constructor(readonly base: unknown, readonly pattern: string) {}
}
export class Uri {
  private constructor(readonly scheme: string, readonly path: string) {}
  static from(value: { scheme: string; path: string }) {
    return new Uri(value.scheme, value.path);
  }
  toString() { return `${this.scheme}://${this.path}`; }
}
export const FileType = { File: 1, Directory: 2 };
const deleted = new EventEmitter<Uri>();
const renamed = new EventEmitter<{ files: { oldUri: Uri; newUri: Uri }[] }>();
const noopEvent = () => new Disposable();
let folder: { uri: Uri; name: string; index: number };
let files: { image: Uri[]; note: Uri[] };
export const calls = { delivered: 0, matchedFolder: 0, imageScan: 0, noteScan: 0 };
export function reset(root: Uri, image: Uri[], note: Uri[]) {
  Object.assign(calls, { delivered: 0, matchedFolder: 0, imageScan: 0, noteScan: 0 });
  deleted.dispose();
  renamed.dispose();
  folder = { uri: root, name: 'work', index: 0 };
  files = { image, note };
}
export function removeFiles() { files = { image: [], note: [] }; }
export function deleteDirectory(uri: Uri) { calls.delivered++; deleted.fire(uri); }
export function renameDirectory(oldUri: Uri, newUri: Uri) {
  calls.delivered++;
  renamed.fire({ files: [{ oldUri, newUri }] });
}
export const workspace = {
  get workspaceFolders() { return [folder]; },
  getWorkspaceFolder(uri: Uri) {
    // Model the provider's folder lookup separately from the driver's routing.
    // File providers accept either drive case; custom providers remain exact.
    const compare = (u: Uri) => u.scheme === 'file'
      ? u.path.replace(/^\/[A-Z]:\//, (drive) => drive.toLowerCase()) : u.path;
    const root = compare(folder.uri);
    const path = compare(uri);
    const matches = uri.scheme === folder.uri.scheme &&
      (path === root || path.startsWith(root.endsWith('/') ? root : root + '/'));
    if (matches) calls.matchedFolder++;
    return matches ? folder : undefined;
  },
  getConfiguration() { return { get: (_key: string, fallback: unknown) => fallback }; },
  createFileSystemWatcher(glob: string) {
    return {
      onDidCreate: noopEvent,
      onDidChange: noopEvent,
      onDidDelete: glob === '**/*' ? deleted.event : noopEvent,
      dispose() {},
    };
  },
  async findFiles(pattern: RelativePattern) {
    if (pattern.pattern === '**/*.png') { calls.imageScan++; return [...files.image]; }
    if (pattern.pattern === '**/*.md') { calls.noteScan++; return [...files.note]; }
    throw new Error('Unexpected test scan pattern: ' + pattern.pattern);
  },
  onDidChangeTextDocument: noopEvent,
  onDidChangeConfiguration: noopEvent,
  onDidRenameFiles: renamed.event,
  onDidCreateFiles: noopEvent,
  onDidDeleteFiles: noopEvent,
  onDidChangeWorkspaceFolders: noopEvent,
  fs: { async stat() { return { type: FileType.Directory }; } },
};

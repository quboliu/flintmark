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
  private constructor(readonly scheme: string, readonly path: string, readonly query = '') {}
  static from(value: { scheme: string; path: string }) {
    return new Uri(value.scheme, value.path);
  }
  static file(path: string) { return Uri.from({ scheme: 'file', path }); }
  static joinPath(base: Uri, ...parts: string[]) { return Uri.from({ scheme: base.scheme, path: base.path.replace(/\/$/, '') + '/' + parts.join('/') }); }
  with(change: { query: string }) { return new Uri(this.scheme, this.path, change.query); }
  get fsPath() { return this.path; }
  toString() { return `${this.scheme}://${this.path}`; }
}
export const FileType = { File: 1, Directory: 2 };
const deleted = new EventEmitter<Uri>();
const created = new EventEmitter<Uri>();
const leafCreated = new Map<string, EventEmitter<Uri>>();
const leafDeleted = new Map<string, EventEmitter<Uri>>();
const renamed = new EventEmitter<{ files: { oldUri: Uri; newUri: Uri }[] }>();
const noopEvent = () => new Disposable();
let folder: { uri: Uri; name: string; index: number };
let files: { image: Uri[]; note: Uri[] };
let scanGate: Promise<void> | undefined;
const directories = new Set<string>();
export const scanTokens: { isCancellationRequested: boolean }[] = [];
export const scanBases: unknown[] = [];
export const notices: string[] = [];
export const configuration = new Map<string, unknown>();
export const noteTexts = new Map<string, string>();
export const scanExcludes: (string | undefined)[] = [];
export const window = { async showInformationMessage(message: string) { notices.push(message); } };
export const calls = { delivered: 0, matchedFolder: 0, imageScan: 0, noteScan: 0 };
export function reset(root: Uri, image: Uri[], note: Uri[]) {
  Object.assign(calls, { delivered: 0, matchedFolder: 0, imageScan: 0, noteScan: 0 });
  deleted.dispose();
  created.dispose();
  leafCreated.clear();
  leafDeleted.clear();
  directories.clear();
  scanTokens.length = 0;
  scanBases.length = 0;
  notices.length = 0;
  configuration.clear();
  noteTexts.clear();
  scanExcludes.length = 0;
  scanGate = undefined;
  renamed.dispose();
  folder = { uri: root, name: 'work', index: 0 };
  files = { image, note };
}
export function removeFiles() { files = { image: [], note: [] }; }
export function holdScans(gate?: Promise<void>) { scanGate = gate; }
export function createDirectory(uri: Uri) { directories.add(uri.path); created.fire(uri); }
export function createLeaf(kind: 'note' | 'image', uri: Uri) {
  files[kind].push(uri);
  for (const [glob, event] of leafCreated) if (glob.includes(kind === 'note' ? 'md' : 'png')) event.fire(uri);
}
export function deleteLeaf(kind: 'note' | 'image', uri: Uri) {
  files[kind] = files[kind].filter((file) => file.path !== uri.path);
  for (const [glob, event] of leafDeleted) if (glob.includes(kind === 'note' ? 'md' : 'png')) event.fire(uri);
}
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
  getConfiguration(section?: string) {
    return { get: (key: string, fallback: unknown) => configuration.get(section ? `${section}.${key}` : key) ?? fallback };
  },
  createFileSystemWatcher(glob: string) {
    const create = new EventEmitter<Uri>();
    const remove = new EventEmitter<Uri>();
    leafCreated.set(glob, create);
    leafDeleted.set(glob, remove);
    return {
      onDidCreate: glob === '**/*' ? created.event : create.event,
      onDidChange: noopEvent,
      onDidDelete: glob === '**/*' ? deleted.event : remove.event,
      dispose() {},
    };
  },
  async findFiles(pattern: RelativePattern, _exclude?: string, _cap?: number, token?: { isCancellationRequested: boolean }) {
    const kind = pattern.pattern.includes('png') ? 'image' : pattern.pattern.includes('md') ? 'note' : undefined;
    if (!kind) throw new Error('Unexpected test scan pattern: ' + pattern.pattern);
    calls[kind === 'image' ? 'imageScan' : 'noteScan']++;
    if (token) scanTokens.push(token);
    scanBases.push(pattern.base);
    scanExcludes.push(_exclude);
    const base = pattern.base as Uri;
    const compare = (uri: Uri) => uri.scheme === 'file'
      ? uri.path.replace(/^\/[A-Z]:\//, (drive) => drive.toLowerCase()) : uri.path;
    const prefix = compare(base).replace(/\/$/, '') + '/';
    const result = files[kind].filter((file) => compare(file).startsWith(prefix));
    await scanGate;
    return _cap === undefined ? result : result.slice(0, _cap);
  },
  onDidChangeTextDocument: noopEvent,
  onDidChangeConfiguration: noopEvent,
  onDidRenameFiles: renamed.event,
  onDidCreateFiles: noopEvent,
  onDidDeleteFiles: noopEvent,
  onDidChangeWorkspaceFolders: noopEvent,
  fs: {
    async readFile(uri: Uri) { return new TextEncoder().encode(noteTexts.get(uri.path) ?? '# Note\n'); },
    async stat(uri: Uri) {
    if (directories.has(uri.path)) return { type: FileType.Directory };
    if ([...files.note, ...files.image].some((file) => file.path === uri.path)) return { type: FileType.File };
    throw Object.assign(new Error('File not found'), { code: 'FileNotFound' });
  } },
};

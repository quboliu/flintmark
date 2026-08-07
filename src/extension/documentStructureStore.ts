import {
  DocumentStructureCache,
  type DocumentStructureSnapshot,
  type StructureParser,
} from "./documentStructureCache";
import { RefreshCoalescer } from "./refreshCoalescer";

export interface StructureDocumentInput {
  uri: string;
  version: number;
  text: string;
}

export interface DocumentStructureStoreOptions {
  initialActiveUri?: string;
  onDidChange: (uri: string | undefined) => void;
  parse?: StructureParser;
  refreshDelayMs?: number;
  maxRefreshDelayMs?: number;
}

/**
 * Host-independent coordinator for active-document structure state. It composes
 * version caching with burst coalescing so the complete scan/update policy is
 * directly unit-testable rather than inferred from tests of its parts.
 */
export class DocumentStructureStore {
  private readonly cache: DocumentStructureCache;
  private readonly refreshCoalescer: RefreshCoalescer;
  private activeUri: string | undefined;

  constructor(private readonly options: DocumentStructureStoreOptions) {
    this.activeUri = options.initialActiveUri;
    this.cache = new DocumentStructureCache(options.parse);
    const delay = options.refreshDelayMs ?? 80;
    this.refreshCoalescer = new RefreshCoalescer(
      delay,
      options.maxRefreshDelayMs ?? delay * 4
    );
  }

  get(document: StructureDocumentInput): DocumentStructureSnapshot {
    return this.cache.get(document.uri, document.version, document.text);
  }

  /** Returns false when duplicate host events reported the same active URI. */
  setActive(
    uri: string | undefined,
    document?: StructureDocumentInput
  ): boolean {
    if (uri === this.activeUri) {
      if (!uri || !document || document.uri !== uri) return false;
      const cached = this.cache.peek(uri);
      if (cached?.version === document.version) return false;
      this.get(document);
      this.options.onDidChange(uri);
      return true;
    }
    this.refreshCoalescer.cancel();
    this.activeUri = uri;
    if (document && document.uri === uri) this.get(document);
    this.options.onDidChange(uri);
    return true;
  }

  scheduleDocumentChange(
    uri: string,
    readLatest: () => StructureDocumentInput | undefined
  ): void {
    if (uri !== this.activeUri) return;
    this.refreshCoalescer.schedule(() => {
      if (uri !== this.activeUri) return;
      const latest = readLatest();
      if (!latest || latest.uri !== uri) return;
      this.get(latest);
      this.options.onDidChange(uri);
    });
  }

  refreshActive(
    uri: string | undefined,
    document?: StructureDocumentInput
  ): void {
    this.refreshCoalescer.cancel();
    if (uri && document && document.uri === uri) {
      this.cache.delete(uri);
      this.get(document);
    }
    this.options.onDidChange(uri);
  }

  close(uri: string): void {
    this.cache.delete(uri);
  }

  dispose(): void {
    this.refreshCoalescer.cancel();
    this.cache.clear();
  }
}

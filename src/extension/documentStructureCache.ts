import {
  parseDocumentStructure,
  type DocumentStructure,
} from "./documentStructureParser";

export interface DocumentStructureSnapshot extends DocumentStructure {
  uri: string;
  version: number;
}

export type StructureParser = (text: string) => DocumentStructure;

/** Version-keyed cache: a document version is structurally parsed at most once. */
export class DocumentStructureCache {
  private readonly snapshots = new Map<string, DocumentStructureSnapshot>();

  constructor(private readonly parse: StructureParser = parseDocumentStructure) {}

  get(uri: string, version: number, text: string): DocumentStructureSnapshot {
    const cached = this.snapshots.get(uri);
    if (cached?.version === version) return cached;

    const parsed = this.parse(text);
    const snapshot: DocumentStructureSnapshot = { uri, version, ...parsed };
    this.snapshots.set(uri, snapshot);
    return snapshot;
  }

  peek(uri: string): DocumentStructureSnapshot | undefined {
    return this.snapshots.get(uri);
  }

  delete(uri: string): void {
    this.snapshots.delete(uri);
  }

  clear(): void {
    this.snapshots.clear();
  }
}

import * as vscode from "vscode";
import type { HeadingInfo } from "./documentStructureParser";
import {
  DocumentStructureService,
} from "./documentStructureService";

/** Opens/reveals a source position in the matching Live Preview document. */
export interface RevealHost {
  revealPositionInDocument(
    uri: vscode.Uri,
    line: number,
    character: number
  ): Promise<void>;
}

type HeadingTarget = HeadingInfo & { uri: vscode.Uri; version: number };

class HeadingItem extends vscode.TreeItem {
  readonly children: HeadingItem[];

  constructor(target: HeadingTarget, children: HeadingItem[]) {
    super(
      target.text,
      children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    this.children = children;
    this.iconPath = new vscode.ThemeIcon(
      `symbol-${target.level <= 2 ? "string" : "key"}`
    );
    this.command = {
      command: "ofm.gotoHeading",
      title: "Go to heading",
      arguments: [target],
    };
  }
}

/** Build a nested HeadingItem tree from the flat heading list (by level). */
function buildTree(
  heads: HeadingInfo[],
  uri: vscode.Uri,
  version: number
): HeadingItem[] {
  let idx = 0;
  const childrenUnder = (parentLevel: number): HeadingItem[] => {
    const items: HeadingItem[] = [];
    while (idx < heads.length && heads[idx].level > parentLevel) {
      const heading = heads[idx];
      idx++;
      const children = childrenUnder(heading.level);
      items.push(new HeadingItem({ ...heading, uri, version }, children));
    }
    return items;
  };
  return childrenUnder(0);
}

class OutlineProvider implements vscode.TreeDataProvider<HeadingItem | vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly structures: DocumentStructureService) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(element?: HeadingItem): (HeadingItem | vscode.TreeItem)[] {
    if (element) return element.children;
    const snapshot = this.structures.getActiveSnapshot();
    if (!snapshot) return [placeholder("Open a Markdown note to see its outline")];
    if (snapshot.headings.length === 0) return [placeholder("No headings")];
    return buildTree(snapshot.headings, vscode.Uri.parse(snapshot.uri), snapshot.version);
  }
}

function placeholder(text: string): vscode.TreeItem {
  const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon("info");
  return item;
}

/** Register the Outline tree view (heading navigation for Live Preview). */
export function registerOutlineView(
  context: vscode.ExtensionContext,
  host: RevealHost,
  structures: DocumentStructureService
): void {
  const provider = new OutlineProvider(structures);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("ofm.outline", provider),
    structures.onDidChange(() => provider.refresh()),
    vscode.commands.registerCommand("ofm.refreshOutline", () => {
      structures.refreshActive();
    }),
    vscode.commands.registerCommand("ofm.gotoHeading", async (target: HeadingTarget) => {
      if (!target?.uri) return;
      const position = structures.resolveHeading(target.uri, target);
      if (position) {
        await host.revealPositionInDocument(
          target.uri,
          position.line,
          position.character
        );
      }
    })
  );
}

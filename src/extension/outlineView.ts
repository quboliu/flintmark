import * as vscode from "vscode";
import { parseHeadings, type HeadingInfo } from "./outlineParser";

const VIEW_TYPE = "ofm.livePreview";

/** Posts a revealLine message to the active Live Preview panel. */
export interface RevealHost {
  revealLineInActivePanel(line: number): boolean;
}

function activeMarkdownUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  let uri: vscode.Uri | undefined;
  if (input instanceof vscode.TabInputCustom) uri = input.uri;
  else if (input instanceof vscode.TabInputText) uri = input.uri;
  else uri = vscode.window.activeTextEditor?.document.uri;
  if (!uri) return undefined;
  return /\.(md|markdown)$/i.test(uri.path) ? uri : undefined;
}

class HeadingItem extends vscode.TreeItem {
  readonly children: HeadingItem[];
  constructor(heading: HeadingInfo, children: HeadingItem[]) {
    super(
      heading.text,
      children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    this.children = children;
    this.iconPath = new vscode.ThemeIcon(`symbol-${heading.level <= 2 ? "string" : "key"}`);
    this.command = {
      command: "ofm.gotoHeading",
      title: "Go to heading",
      arguments: [heading.line],
    };
  }
}

/** Build a nested HeadingItem tree from the flat heading list (by level).
 *  Children are built FIRST (recursively) so each item's collapsible state is
 *  decided with its full child count. */
function buildTree(heads: HeadingInfo[]): HeadingItem[] {
  let idx = 0;
  const childrenUnder = (parentLevel: number): HeadingItem[] => {
    const items: HeadingItem[] = [];
    while (idx < heads.length && heads[idx].level > parentLevel) {
      const h = heads[idx];
      idx++;
      const kids = childrenUnder(h.level); // consume deeper headings as children
      items.push(new HeadingItem(h, kids));
    }
    return items;
  };
  return childrenUnder(0);
}

class OutlineProvider implements vscode.TreeDataProvider<HeadingItem | vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(element?: HeadingItem): (HeadingItem | vscode.TreeItem)[] {
    if (element) return element.children;
    const uri = activeMarkdownUri();
    if (!uri) return [placeholder("Open a Markdown note to see its outline")];
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === uri.toString()
    );
    const text = doc?.getText();
    if (text === undefined) return [placeholder("No outline")];
    const heads = parseHeadings(text);
    if (heads.length === 0) return [placeholder("No headings")];
    return buildTree(heads);
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
  host: RevealHost
): void {
  const provider = new OutlineProvider();
  const refresh = (): void => provider.refresh();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("ofm.outline", provider),
    vscode.window.tabGroups.onDidChangeTabs(refresh),
    vscode.window.onDidChangeActiveTextEditor(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (activeMarkdownUri()?.toString() === e.document.uri.toString()) refresh();
    }),
    vscode.commands.registerCommand("ofm.refreshOutline", refresh),
    vscode.commands.registerCommand("ofm.gotoHeading", (line: number) => {
      if (!host.revealLineInActivePanel(line)) {
        // Fall back to opening in Live Preview, then the panel will be live.
        const uri = activeMarkdownUri();
        if (uri) void vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
      }
    })
  );
}

import * as vscode from "vscode";
import { VaultIndexService } from "./vault";

const VIEW_TYPE = "ofm.livePreview";

/** The active Markdown document's URI — works for BOTH our custom (webview)
 *  editor (where activeTextEditor is undefined) and a plain text editor. */
function activeMarkdownUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  let uri: vscode.Uri | undefined;
  if (input instanceof vscode.TabInputCustom) uri = input.uri;
  else if (input instanceof vscode.TabInputText) uri = input.uri;
  else uri = vscode.window.activeTextEditor?.document.uri;
  if (!uri) return undefined;
  return /\.(md|markdown)$/i.test(uri.path) ? uri : undefined;
}

function baseName(uri: vscode.Uri): string {
  return uri.path.split("/").pop()?.replace(/\.(md|markdown)$/i, "") ?? uri.path;
}

class BacklinkItem extends vscode.TreeItem {
  constructor(uri: vscode.Uri) {
    super(baseName(uri), vscode.TreeItemCollapsibleState.None);
    this.resourceUri = uri;
    this.iconPath = new vscode.ThemeIcon("references");
    this.tooltip = uri.fsPath;
    this.command = {
      command: "vscode.openWith",
      title: "Open note",
      arguments: [uri, VIEW_TYPE],
    };
  }
}

class BacklinksProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly vault: VaultIndexService) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): vscode.TreeItem[] {
    const uri = activeMarkdownUri();
    if (!uri) return [placeholder("Open a Markdown note to see its backlinks")];
    const links = this.vault.getBacklinks(uri);
    if (links.length === 0) return [placeholder("No backlinks")];
    return links
      .map((s) => {
        try {
          return new BacklinkItem(vscode.Uri.parse(s));
        } catch {
          return null;
        }
      })
      .filter((x): x is BacklinkItem => x !== null);
  }
}

function placeholder(text: string): vscode.TreeItem {
  const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon("info");
  return item;
}

/** Register the Backlinks tree view (Explorer sidebar). */
export function registerBacklinks(
  context: vscode.ExtensionContext,
  vault: VaultIndexService
): void {
  const provider = new BacklinksProvider(vault);
  const refresh = (): void => provider.refresh();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("ofm.backlinks", provider),
    vscode.window.tabGroups.onDidChangeTabs(refresh),
    vscode.window.onDidChangeActiveTextEditor(refresh),
    vscode.workspace.onDidSaveTextDocument(refresh),
    vscode.commands.registerCommand("ofm.refreshBacklinks", refresh)
  );
}

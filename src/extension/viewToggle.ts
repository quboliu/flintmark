import * as vscode from "vscode";

const VIEW_TYPE = "ofm.livePreview";

/**
 * A status-bar Live/Code toggle. The editor-title buttons (menus.editor/title)
 * are host-controlled — Cursor pushes them into the "…" overflow — so the
 * status bar gives a reliable, always-visible toggle in every host. Shows the
 * CURRENT view; clicking switches to the other.
 */
export function registerViewToggle(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(item);

  const update = (): void => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE) {
      item.text = "$(book) Live";
      item.tooltip = "Flintmark: viewing Live Preview — click to switch to Code (raw Markdown)";
      item.command = "ofm.openAsSource";
      item.show();
    } else if (
      input instanceof vscode.TabInputText &&
      /\.(md|markdown)$/i.test(input.uri.path)
    ) {
      item.text = "$(code) Code";
      item.tooltip = "Flintmark: viewing Markdown source — click to switch to Live Preview";
      item.command = "ofm.openAsLivePreview";
      item.show();
    } else {
      item.hide();
    }
  };

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(update),
    vscode.window.tabGroups.onDidChangeTabGroups(update),
    vscode.window.onDidChangeActiveTextEditor(update)
  );
  update();
}

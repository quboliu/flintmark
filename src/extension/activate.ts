import * as vscode from "vscode";
import { DocumentSyncManager } from "./documentSync";
import { OfmCustomTextEditorProvider } from "./customTextEditorProvider";
import { registerCommands } from "./commands";
import { registerOutline } from "./outline";
import { registerOutlineView } from "./outlineView";
import { registerBacklinks } from "./backlinksView";
import { registerViewToggle } from "./viewToggle";
import { VaultIndexService } from "./vault";
import { ImageIndexService } from "./vault/imageIndexService";

export function activate(context: vscode.ExtensionContext): void {
  const syncManager = new DocumentSyncManager();

  // Vault Index: scans the workspace so wikilinks resolve by name and (later)
  // backlinks/tags work. Built by a parallel worktree agent; wired in here.
  const vault = new VaultIndexService();
  void vault.initialize();
  context.subscriptions.push(vault);

  // Image Index: per-root, path-only index so Obsidian image embeds (`![[img.png]]`)
  // and bare relative images resolve vault-wide (attachments-folder layout) and
  // render. Non-blocking scan; resolution itself is synchronous on the hot path.
  const imageIndex = new ImageIndexService();
  void imageIndex.initialize();
  context.subscriptions.push(imageIndex);

  const provider = new OfmCustomTextEditorProvider(
    context,
    syncManager,
    vault,
    imageIndex
  );

  registerCommands(context, provider);
  registerOutline(context); // DocumentSymbolProvider (powers Outline in SOURCE view)
  registerOutlineView(context, provider); // our own Outline panel (Live Preview)
  registerBacklinks(context, vault);
  registerViewToggle(context); // status-bar Live/Code toggle (reliable in all hosts)

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "ofm.livePreview",
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  // Clean up suppression set on deactivate.
  context.subscriptions.push({
    dispose: () => syncManager.dispose(),
  });

  console.log("[ofm] activated");
}

export function deactivate(): void {
  console.log("[ofm] deactivated");
}

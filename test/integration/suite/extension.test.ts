// L2 integration tests: exercise the host/wiring layer that unit tests can't
// reach (it needs a real VS Code) and that the L3 webview e2e doesn't cover —
// command registration/activation integrity, the view-switching + set-default
// commands, and the heading outline (DocumentSymbol) provider. The webview-side
// data path (edit → disk, checkbox → disk) is covered by L3; the pure edit
// machinery (SerialQueue, documentSync, clampOffsetRange) by L1.
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const VIEW_TYPE = "ofm.livePreview";
const EXT_ID = "quboliu.flintmark";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Flatten DocumentSymbol[] (nested) or SymbolInformation[] (flat) to names. */
function symbolNames(syms: unknown): string[] {
  const out: string[] = [];
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const s of list as { name?: string; children?: unknown }[]) {
      if (s && typeof s.name === "string") out.push(s.name);
      if (s && s.children) walk(s.children);
    }
  };
  walk(syms);
  return out;
}

describe("OFM custom editor (integration)", () => {
  let file: vscode.Uri;

  before(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofm-it-"));
    const fp = path.join(dir, "note.md");
    fs.writeFileSync(fp, "# Hello\n\nworld\n\n## Sub\n\nmore\n");
    file = vscode.Uri.file(fp);
  });

  afterEach(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await delay(300);
  });

  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("opens a .md in our custom editor and binds it to the file", async () => {
    await vscode.commands.executeCommand("vscode.openWith", file, VIEW_TYPE);
    await delay(2000);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const ofmTab = tabs.find(
      (t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === VIEW_TYPE
    );
    assert.ok(ofmTab, `expected a tab opened with viewType ${VIEW_TYPE}`);
    assert.strictEqual((ofmTab!.input as vscode.TabInputCustom).uri.fsPath, file.fsPath);
  });

  it("registers every contributed ofm.* command (activation integrity)", async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} should be present`);
    await ext!.activate();
    const contributed = (
      ext!.packageJSON?.contributes?.commands as { command: string }[] | undefined
    )?.map((c) => c.command) ?? [];
    assert.ok(contributed.length > 0, "package.json should contribute commands");
    const all = await vscode.commands.getCommands(true);
    for (const cmd of contributed) {
      assert.ok(all.includes(cmd), `contributed command not registered: ${cmd}`);
    }
  });

  it("ofm.openAsSource opens the source text editor for a custom-editor doc", async () => {
    await vscode.commands.executeCommand("vscode.openWith", file, VIEW_TYPE);
    await delay(1500);
    await vscode.commands.executeCommand("ofm.openAsSource");
    await delay(1500);
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.fsPath,
      file.fsPath,
      "active editor should be the source text editor for the same file"
    );
  });

  it("ofm.openAsLivePreview re-opens a source doc in the custom editor", async () => {
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await delay(800);
    await vscode.commands.executeCommand("ofm.openAsLivePreview");
    await delay(1500);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const ofmTab = tabs.find(
      (t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === VIEW_TYPE
    );
    assert.ok(ofmTab, "a custom-editor tab should be open after openAsLivePreview");
  });

  it("ofm.setAsDefaultEditor registers the markdown editor association", async () => {
    const cfg = () =>
      vscode.workspace.getConfiguration().get<Record<string, string>>("workbench.editorAssociations") ?? {};
    const before = { ...cfg() };
    try {
      await vscode.commands.executeCommand("ofm.setAsDefaultEditor");
      await delay(600);
      assert.strictEqual(cfg()["*.md"], VIEW_TYPE, "*.md should map to our editor");
    } finally {
      await vscode.workspace
        .getConfiguration()
        .update("workbench.editorAssociations", before, vscode.ConfigurationTarget.Global);
    }
  });

  it("provides heading symbols (outline) for a markdown file", async () => {
    await vscode.workspace.openTextDocument(file);
    const syms = await vscode.commands.executeCommand(
      "vscode.executeDocumentSymbolProvider",
      file
    );
    const names = symbolNames(syms);
    assert.ok(names.includes("Hello"), `outline should list 'Hello', got ${JSON.stringify(names)}`);
    assert.ok(names.includes("Sub"), `outline should list 'Sub', got ${JSON.stringify(names)}`);
  });
});

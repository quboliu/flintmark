import { relFromRoot, WorkspaceIndexDriver } from "../../../src/extension/vault/workspaceIndexDriver";
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

  it("ofm.gotoTodo opens a source-only document in Live Preview", async () => {
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    await delay(500);

    await vscode.commands.executeCommand("ofm.gotoTodo", {
      uri: file,
      version: doc.version,
      status: " ",
      text: "task",
      line: 2,
      character: 2,
      markerFrom: 10,
      markerTo: 13,
    });
    await delay(1500);

    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const liveTab = tabs.find(
      (tab) =>
        tab.input instanceof vscode.TabInputCustom &&
        tab.input.viewType === VIEW_TYPE &&
        tab.input.uri.fsPath === file.fsPath
    );
    assert.ok(liveTab, "Todo navigation should open the matching Live Preview document");
  });
});

describe("Workspace index scan scheduling", () => {
  it("publishes the first build before one coalesced rate-limited follow-up", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ofm-index-"));
    fs.writeFileSync(path.join(folder, "note.md"), "# Indexed");
    const root = vscode.Uri.file(folder);
    const driver = new WorkspaceIndexDriver();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstStarted = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    let active = 0;
    let maximum = 0;
    const handle = driver.registerSpec({
      kind: "note", include: "**/*.md", notReady: () => [] as string[],
      build: async (_root, files, context) => {
        calls++; active++; maximum = Math.max(maximum, active);
        const current = calls;
        try {
          if (current === 1) { entered(); await gate; }
          return context.isCurrent() ? files.map((file) => file.toString()) : ["stale"];
        } finally { active--; }
      },
    });
    const firstPublished = new Promise<void>((resolve) => driver.onDidRefresh((event) => {
      if (event.version === 1) resolve();
    }));
    const done = new Promise<void>((resolve) => driver.onDidRefresh((event) => {
      if (event.version === 2) resolve();
    }));
    try {
      handle.requestRefresh(root, "first", true);
      await firstStarted;
      fs.writeFileSync(path.join(folder, "new.md"), "# New");
      handle.requestRefresh(root, "queued", true);
      handle.requestRefresh(root, "latest", true);
      await delay(100);
      assert.strictEqual(calls, 1, "new scans must wait for the old build");
      release();
      await firstPublished;
      assert.strictEqual(maximum, 1);
      assert.strictEqual(calls, 1, "the first build publishes without waiting for a rescan");
      assert.deepStrictEqual(handle.snapshot(root), [vscode.Uri.file(path.join(folder, "note.md")).toString()]);
      await done;
      assert.strictEqual(maximum, 1);
      assert.strictEqual(calls, 2, "full requests coalesce into one follow-up");
      assert.deepStrictEqual(handle.snapshot(root)?.slice().sort(), ["new.md", "note.md"].map((name) =>
        vscode.Uri.file(path.join(folder, name)).toString()).sort());
    } finally {
      release();
      driver.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});


describe("Workspace image paths", () => {
  const file = (path: string) => vscode.Uri.from({ scheme: "file", path });

  it("strips the workspace root despite Windows drive-letter casing", () => {
    for (const rootDrive of ["C", "c"]) {
      for (const fileDrive of ["C", "c"]) {
        for (const trailingSlash of ["", "/"]) {
          assert.strictEqual(
            relFromRoot(file("/" + rootDrive + ":/Notes" + trailingSlash), file("/" + fileDrive + ":/Notes/assets/Photo.PNG")),
            "assets/Photo.PNG"
          );
        }
      }
    }
  });

  it("preserves spaces, Unicode, and filename case in image references", () => {
    assert.strictEqual(
      relFromRoot(file("/C:/My Notes"), file("/c:/My Notes/assets/画像 Photo.SVG")),
      "assets/画像 Photo.SVG"
    );
  });

  it("handles a Windows drive root", () => {
    assert.strictEqual(relFromRoot(file("/D:/"), file("/d:/Photo.png")), "Photo.png");
  });

  it("does not confuse a neighboring folder or a different drive with the root", () => {
    assert.strictEqual(relFromRoot(file("/C:/Notes"), file("/c:/Notes-archive/photo.png")), "c:/Notes-archive/photo.png");
    assert.strictEqual(relFromRoot(file("/C:/Notes"), file("/d:/Notes/photo.png")), "d:/Notes/photo.png");
  });

  it("preserves case-sensitive directory boundaries and POSIX roots", () => {
    assert.strictEqual(relFromRoot(file("/vault"), file("/vault/Photo.PNG")), "Photo.PNG");
    assert.strictEqual(relFromRoot(file("/vault"), file("/Vault/Photo.PNG")), "Vault/Photo.PNG");
    assert.strictEqual(relFromRoot(file("/"), file("/vault/Photo.PNG")), "vault/Photo.PNG");
    assert.strictEqual(relFromRoot(file("/C:/Notes"), file("/c:/notes/Photo.PNG")), "c:/notes/Photo.PNG");
  });

  it("does not rewrite drive-like paths belonging to non-file providers", () => {
    const root = vscode.Uri.from({ scheme: "custom", path: "/C:/Notes" });
    const image = vscode.Uri.from({ scheme: "custom", path: "/c:/Notes/photo.png" });
    assert.strictEqual(relFromRoot(root, image), "c:/Notes/photo.png");
  });
});

// A source tab may coexist with a hidden custom-editor tab. Navigation must
// reveal the existing preview instead of disposing and racing its replacement.
describe("Todo navigation to an existing hidden preview", () => {
  for (const split of [false, true]) {
    it(`reuses the same preview tab${split ? " across editor groups" : " in one group"}`, async () => {
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ofm-hidden-preview-"));
      const note = vscode.Uri.file(path.join(folder, "target.md"));
      const other = vscode.Uri.file(path.join(folder, "other.txt"));
      const text = "# Navigation\n\n- [ ] target task\n";
      fs.writeFileSync(note.fsPath, text);
      fs.writeFileSync(other.fsPath, "Another editor hides the preview.\n");
      const matchingTabs = () => vscode.window.tabGroups.all.flatMap(group =>
        group.tabs.filter(tab => tab.input instanceof vscode.TabInputCustom &&
          tab.input.viewType === VIEW_TYPE && tab.input.uri.toString() === note.toString())
          .map(tab => ({ group, tab })),
      );
      let trace: vscode.Disposable | undefined;
      try {
        await vscode.commands.executeCommand("vscode.openWith", note, VIEW_TYPE, { viewColumn: vscode.ViewColumn.One, preview: false });
        await delay(1500);
        assert.strictEqual(matchingTabs().length, 1);
        const original = matchingTabs()[0];
        const tabEvents: {kind:string; uri:string; viewType:string}[] = [];
        trace = vscode.window.tabGroups.onDidChangeTabs(event => {
          for (const kind of ["opened","closed","changed"] as const) for (const tab of event[kind]) {
            if (tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === note.toString())
              tabEvents.push({kind,uri:tab.input.uri.toString(),viewType:tab.input.viewType});
          }
        });
        const document = await vscode.workspace.openTextDocument(note);
        await vscode.window.showTextDocument(other, { viewColumn: original.group.viewColumn, preview: false });
        await vscode.window.showTextDocument(document, {
          viewColumn: split ? vscode.ViewColumn.Beside : original.group.viewColumn,
          preview: false,
        });
        assert.strictEqual(matchingTabs()[0].tab.isActive, false, "preview must actually be hidden before navigating");
        const wrapperPreservedBeforeNavigation = matchingTabs()[0]?.tab === original.tab;
        const eventsBeforeNavigation = tabEvents.length;
        const markerFrom = text.indexOf("[ ]");
        await vscode.commands.executeCommand("ofm.gotoTodo", {
          uri: note, version: document.version, status: " ", text: "target task",
          line: 2, character: 2, markerFrom, markerTo: markerFrom + 3,
        });
        const deadline = Date.now() + 5000;
        // The tab activation and active-group events can reach the extension
        // host separately. Wait for both within the original deadline.
        while ((!matchingTabs()[0]?.tab.isActive ||
          vscode.window.tabGroups.activeTabGroup.viewColumn !== original.group.viewColumn) &&
          Date.now() < deadline) await delay(25);
        const after = matchingTabs();
        console.log("TAB_IDENTITY_DIAGNOSTIC",JSON.stringify({split,wrapperPreservedBeforeNavigation,wrapperPreservedAfterNavigation:after[0]?.tab===original.tab,eventsBeforeNavigation,tabEvents,afterCount:after.length,afterActive:after[0]?.tab.isActive,originalActive:original.tab.isActive}));
        assert.strictEqual(after.length, 1, "navigation must not duplicate the preview");
        // Cursor can replace API Tab wrappers during an ordinary source-tab open,
        // before Flintmark navigation runs. Assert actual tab lifetime instead.
        assert.deepStrictEqual(tabEvents.filter(event => event.kind !== "changed"), [],
          "hiding and revealing must not close or recreate the preview tab");
        assert.strictEqual(after[0].group.viewColumn, original.group.viewColumn, "preview must stay in its original group");
        assert.strictEqual(after[0].tab.isActive, true, "navigation must reveal the hidden preview");
        assert.strictEqual(vscode.window.tabGroups.activeTabGroup.viewColumn, original.group.viewColumn, "focus must follow the revealed preview");
      } finally {
        trace?.dispose();
        await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      }
    });
  }
});

// L2 integration test: proves the extension ACTIVATES and the custom editor
// RESOLVES in a real editor instance — something `tsc`/unit tests cannot show.
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const VIEW_TYPE = "ofm.livePreview";

describe("OFM custom editor (integration)", () => {
  let file: vscode.Uri;

  before(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofm-it-"));
    const fp = path.join(dir, "note.md");
    fs.writeFileSync(fp, "# Hello\n\nworld\n");
    file = vscode.Uri.file(fp);
  });

  after(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("opens a .md in our custom editor and binds it to the file", async () => {
    await vscode.commands.executeCommand("vscode.openWith", file, VIEW_TYPE);

    // Let VS Code resolve the custom editor + create the tab.
    await new Promise((r) => setTimeout(r, 2000));

    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const ofmTab = tabs.find(
      (t) =>
        t.input instanceof vscode.TabInputCustom &&
        t.input.viewType === VIEW_TYPE
    );

    assert.ok(ofmTab, `expected a tab opened with viewType ${VIEW_TYPE}`);
    const input = ofmTab.input as vscode.TabInputCustom;
    assert.strictEqual(
      input.uri.fsPath,
      file.fsPath,
      "custom editor should be bound to our .md file"
    );
  });
});

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { EditorState } from "@codemirror/state";
import { collab, getSyncedVersion, receiveUpdates, sendableUpdates } from "@codemirror/collab";
import { OfmCustomTextEditorProvider } from "../../../src/extension/customTextEditorProvider";
import { DocumentSyncManager } from "../../../src/extension/documentSync";
import { decodeUpdates, encodeUpdates } from "../../../src/shared/collaboration";

// Real TextDocuments, change events, WorkspaceEdit version validation and disk
// writes; only the webview transport is simulated. All CodeMirror imports use
// the same runtime module instance as the bundled provider.
describe("Collaboration acknowledgments in the real extension host", () => {
  for (const scenario of ["coincident", "different", "nine-conflicts", "to-lf", "to-crlf", "noop-external"] as const) {
    it(`preserves independent edits: ${scenario}`, async () => {
      const multiline = scenario === "to-lf" || scenario === "to-crlf";
      const initial = multiline ? (scenario === "to-lf" ? "a\r\nb\r\nc" : "a\nb\nc") : "abc";
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), "flintmark-collab-"));
      const file = path.join(folder, "note.md");
      fs.writeFileSync(file, initial);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const subscriptions: vscode.Disposable[] = [];
      const context = { subscriptions, extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")) } as unknown as vscode.ExtensionContext;
      // The adapter deliberately reaches the queue boundary so an actual API
      // version conflict can be injected deterministically, without production
      // test hooks or replacing WorkspaceEdit itself.
      const provider = new OfmCustomTextEditorProvider(context, new DocumentSyncManager()) as any;
      let client = EditorState.create({
        doc: initial.replace(/\r\n/g, "\n"),
        extensions: [collab({ clientID: "test-panel" })],
      });
      client = client.update({ changes: scenario === "noop-external"
        ? { from: 1, to: 2, insert: "b" }
        : { from: 1, insert: "X" } }).state;
      const messages: any[] = [];
      const panel = {
        active: true,
        webview: {
          asWebviewUri: (uri: vscode.Uri) => uri,
          postMessage: (message: any) => {
            messages.push(message);
            if (message.type === "syncUpdates") {
              client = client.update(receiveUpdates(client, decodeUpdates(message.updates))).state;
            }
            return Promise.resolve(true);
          },
        },
      };
      const key = document.uri.toString();
      provider.panels.set(key, new Map([[panel, { document, panel }]]));
      provider.readyPanels.add(panel);
      const apply = provider.applyWebviewEdit.bind(provider);
      let attempts = 0;
      let rejections = 0;
      provider.applyWebviewEdit = async (doc: vscode.TextDocument, changes: unknown) => {
        attempts++;
        if (scenario === "noop-external") {
          const applied = await apply(doc, changes);
          const external = new vscode.WorkspaceEdit();
          external.insert(document.uri, document.positionAt(document.getText().length), "Y");
          assert.equal(await vscode.workspace.applyEdit(external), true);
          return applied;
        }
        const competingAttempts = scenario === "nine-conflicts" ? 9 : 1;
        if (attempts > competingAttempts) return apply(doc, changes);
        const external = new vscode.WorkspaceEdit();
        if (multiline) {
          external.set(document.uri, [vscode.TextEdit.setEndOfLine(
            scenario === "to-lf" ? vscode.EndOfLine.LF : vscode.EndOfLine.CRLF,
          )]);
        } else {
          const offset = scenario === "coincident" ? 1 : document.getText().length;
          external.insert(document.uri, document.positionAt(offset), scenario === "coincident" ? "X" : "Y");
        }
        // Launch both before awaiting either: both capture the same version.
        // The first wins and VS Code must reject the second as stale.
        const competing = vscode.workspace.applyEdit(external);
        const own = apply(doc, changes);
        const [externalApplied, ownApplied] = await Promise.all([competing, own]);
        assert.equal(externalApplied, true);
        assert.equal(ownApplied, false, "the required real version conflict must occur");
        rejections++;
        return ownApplied;
      };
      try {
        provider.enqueueEdit(document, panel, {
          type: "edit", version: document.version,
          syncVersion: getSyncedVersion(client), updates: encodeUpdates(sendableUpdates(client)),
        });
        await provider.editQueue.idle(key);
        const expected = scenario === "coincident" ? "aXXbc"
          : scenario === "noop-external" ? "abcY"
          : multiline ? "aX\nb\nc"
          : "aXbc" + "Y".repeat(scenario === "nine-conflicts" ? 9 : 1);
        assert.equal(document.getText().replace(/\r\n/g, "\n"), expected);
        assert.equal(provider.authorities.get(key).doc.toString(), expected);
        assert.equal(client.doc.toString(), expected);
        assert.equal(sendableUpdates(client).length, 0, "must converge without manual resubmission");
        assert.equal(messages.some(message => message.type === "syncError"), false);
        assert.equal(rejections, scenario === "noop-external" ? 0 : scenario === "nine-conflicts" ? 9 : 1);
        await document.save();
        assert.equal(fs.readFileSync(file, "utf8"), scenario === "to-crlf" ? expected.replace(/\n/g, "\r\n") : expected);
      } finally {
        for (const subscription of subscriptions) subscription.dispose();
      }
    });
  }
});

describe("Cumulative input batches behind a slow native edit", () => {
  for (const scenario of ["burst", "closed-panel", "command-barrier", "second-panel", "rejected-first"] as const) {
    it(`preserves input and queue ordering: ${scenario}`, async () => {
      const initial = "base\n", folder = fs.mkdtempSync(path.join(os.tmpdir(), "flintmark-burst-"));
      const file = path.join(folder, "note.md");
      fs.writeFileSync(file, initial);
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const subscriptions: vscode.Disposable[] = [];
      const context = { subscriptions, extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")) } as unknown as vscode.ExtensionContext;
      const provider = new OfmCustomTextEditorProvider(context, new DocumentSyncManager()) as any;
      const key = document.uri.toString(), messages: any[] = [];
      const clients = new Map<string, EditorState>();
      function makePanel(id: string) {
        clients.set(id, EditorState.create({ doc: initial, extensions: [collab({ clientID: id })] }));
        return { active: true, webview: { asWebviewUri: (uri: vscode.Uri) => uri, postMessage: (message: any) => {
          messages.push(message);
          if (message.type === "syncUpdates") clients.set(id, clients.get(id)!.update(receiveUpdates(clients.get(id)!, decodeUpdates(message.updates))).state);
          return Promise.resolve(true);
        } } };
      }
      const a = makePanel("a"), b = makePanel("b");
      provider.panels.set(key, new Map([[a, { document, panel: a }], [b, { document, panel: b }]]));
      provider.readyPanels.add(a); provider.readyPanels.add(b);
      function send(panel: typeof a, id: string, text: string) {
        const state = clients.get(id)!;
        const next = state.update({ changes: { from: state.doc.length, insert: text } }).state;
        clients.set(id, next);
        provider.enqueueEdit(document, panel, { type: "edit", version: document.version, syncVersion: getSyncedVersion(next), updates: encodeUpdates(sendableUpdates(next)) });
      }
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const apply = provider.applyWebviewEdit.bind(provider);
      let calls = 0, active = 0, maxActive = 0, barrierText: string | undefined;
      provider.notifyConflict = () => undefined;
      provider.applyWebviewEdit = async (doc: vscode.TextDocument, changes: unknown) => {
        calls++; active++; maxActive = Math.max(maxActive, active);
        try {
          if (calls === 1) { entered(); await gate; if (scenario === "rejected-first") return false; }
          return await apply(doc, changes);
        } finally { active--; }
      };
      try {
        send(a, "a", "a"); await started;
        for (const ch of "bcd") send(a, "a", ch);
        if (scenario === "command-barrier") void provider.editQueue.run(key, async () => { barrierText = document.getText(); });
        if (scenario === "second-panel") send(b, "b", "FOREIGN");
        for (const ch of "efghijklmnopqrstuvwxyz") send(a, "a", ch);
        if (scenario === "closed-panel") { provider.panels.get(key).delete(a); provider.readyPanels.delete(a); }
        release(); await provider.editQueue.idle(key); await Promise.resolve();
        const expected = initial + "abcdefghijklmnopqrstuvwxyz";
        assert.equal(document.getText().replace("FOREIGN", ""), expected);
        assert.equal(maxActive, 1, "native edits must remain strictly serial");
        assert.equal(calls, scenario === "command-barrier" ? 3 : scenario === "second-panel" ? 4 : 2, "a blocked typing burst must not produce one API call per character");
        if (scenario === "command-barrier") assert.equal(barrierText, initial + "abcd", "later input must not cross a queued command");
        if (scenario === "second-panel") assert.ok(document.getText().includes("FOREIGN"));
        for (const [id, state] of clients) {
          if (scenario === "closed-panel" && id === "a") continue;
          assert.equal(state.doc.toString(), document.getText());
          assert.equal(sendableUpdates(state).length, 0, "all individual collaboration updates must be acknowledged");
        }
        assert.equal(provider.queuedEdits.size, 0, "settled batches must not retain panels");
        assert.equal(provider.conflicts.has(key), false, "the complete later batch must recover a rejected prefix");
        await document.save();
        assert.equal(fs.readFileSync(file, "utf8"), document.getText());
      } finally { release(); for (const subscription of subscriptions) subscription.dispose(); }
    });
  }
});

// Pure-logic test for the host (IDE) adaptation layer (runs in Node via
// test/run-unit.mjs). Verifies detection picks the right adapter per IDE and
// that each maps intents to the verified commands — incl. the fork-precedence
// case (Antigravity is a VS Code fork, must NOT be detected as plain VS Code).
import assert from "node:assert";
import { selectHostAdapter } from "../../src/extension/ai/hostAdapters";

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (e as Error).message);
  }
}
const ctx = (appName: string | undefined, ...cmds: string[]) => ({
  available: new Set(cmds),
  appName,
});

test("Antigravity detected by appName; chat=toggleChatFocus, edit=openInteractiveEditor", () => {
  const c = ctx("Antigravity IDE", "antigravity.toggleChatFocus", "antigravity.openInteractiveEditor");
  const a = selectHostAdapter(c);
  assert.equal(a.id, "antigravity");
  assert.equal(a.chat(c)?.command, "antigravity.toggleChatFocus");
  assert.equal(a.edit(c)?.command, "antigravity.openInteractiveEditor");
  assert.equal(a.chat(c)?.kind, "chat");
  assert.equal(a.edit(c)?.kind, "inline");
});

test("Antigravity detected by command signature even with no appName", () => {
  const c = ctx(undefined, "antigravity.toggleChatFocus");
  assert.equal(selectHostAdapter(c).id, "antigravity");
});

test("Antigravity (a VS Code fork) wins over the VS Code adapter", () => {
  // It exposes inlineChat.start too — must still resolve to antigravity.
  const c = ctx("Antigravity IDE", "antigravity.toggleChatFocus", "inlineChat.start", "workbench.action.chat.attachSelection");
  assert.equal(selectHostAdapter(c).id, "antigravity");
});

test("Cursor: chat=aichat.newchataction, edit=aipopup.action.modal.generate", () => {
  const c = ctx("Cursor", "aichat.newchataction", "aipopup.action.modal.generate", "inlineChat.start");
  const a = selectHostAdapter(c);
  assert.equal(a.id, "cursor");
  assert.equal(a.chat(c)?.command, "aichat.newchataction");
  assert.equal(a.edit(c)?.command, "aipopup.action.modal.generate");
});

test("VS Code / Copilot: chat=attachSelection, edit=inlineChat.start", () => {
  const c = ctx("Visual Studio Code", "workbench.action.chat.attachSelection", "inlineChat.start");
  const a = selectHostAdapter(c);
  assert.equal(a.id, "vscode");
  assert.equal(a.chat(c)?.command, "workbench.action.chat.attachSelection");
  assert.equal(a.edit(c)?.command, "inlineChat.start");
});

test("VSCodium detected by command signature (appName has no 'code')", () => {
  const c = ctx("VSCodium", "inlineChat.start", "workbench.action.chat.attachSelection");
  assert.equal(selectHostAdapter(c).id, "vscode");
});

test("override is honored when the command is available", () => {
  const c = ctx("Cursor", "aichat.newchataction", "my.custom.chat");
  assert.equal(selectHostAdapter(c).chat(c, "my.custom.chat")?.command, "my.custom.chat");
});

test("override is ignored when the command is NOT available", () => {
  const c = ctx("Cursor", "aichat.newchataction");
  assert.equal(selectHostAdapter(c).chat(c, "not.registered")?.command, "aichat.newchataction");
});

test("unknown host falls back to the generic adapter", () => {
  const c = ctx("Mystery IDE", "workbench.action.chat.open");
  const a = selectHostAdapter(c);
  assert.equal(a.id, "generic");
  assert.equal(a.chat(c)?.command, "workbench.action.chat.open");
});

test("matched adapter with no usable command returns null (→ bridge hints)", () => {
  // Antigravity matched by appName, but its chat command isn't registered.
  const c = ctx("Antigravity IDE", "antigravity.openAgent");
  const a = selectHostAdapter(c);
  assert.equal(a.id, "antigravity");
  assert.equal(a.chat(c), null);
});

if (failed > 0) {
  console.error(`\n${failed} hostAdapters test(s) FAILED`);
  process.exit(1);
}
console.log("hostAdapters tests passed");

// Pure-logic test for AI command selection (no vscode). Mirrors the real probe
// data: Cursor exposes aipopup.action.modal.generate; VS Code exposes
// inlineChat.start. Runs in Node via test/run-unit.mjs.
import assert from "node:assert";
import {
  pickAiTrigger,
  pickAiAccept,
  pickChatTrigger,
} from "../../src/extension/ai/aiCommands";

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

test("VS Code / VSCodium → inlineChat.start (inline)", () => {
  const avail = new Set(["inlineChat.start", "workbench.action.chat.open"]);
  assert.deepEqual(pickAiTrigger(avail), { command: "inlineChat.start", kind: "inline" });
});

test("Cursor → aipopup.action.modal.generate (inline)", () => {
  const avail = new Set([
    "aipopup.action.modal.generate",
    "composer.addfilestocomposer",
    "workbench.action.chat.open",
  ]);
  assert.deepEqual(pickAiTrigger(avail), {
    command: "aipopup.action.modal.generate",
    kind: "inline",
  });
});

test("no inline AI → chat fallback", () => {
  const avail = new Set(["workbench.action.chat.open"]);
  assert.deepEqual(pickAiTrigger(avail), {
    command: "workbench.action.chat.open",
    kind: "chat",
  });
});

test("no AI at all → null (caller degrades to manual)", () => {
  assert.equal(pickAiTrigger(new Set(["editor.action.formatDocument"])), null);
});

test("explicit override wins when available", () => {
  const avail = new Set(["inlineChat.start", "my.custom.ai"]);
  assert.deepEqual(pickAiTrigger(avail, "my.custom.ai"), {
    command: "my.custom.ai",
    kind: "inline",
  });
});

test("override ignored when not registered → falls back to detection", () => {
  const avail = new Set(["inlineChat.start"]);
  assert.deepEqual(pickAiTrigger(avail, "not.registered"), {
    command: "inlineChat.start",
    kind: "inline",
  });
});

test("VS Code add-to-chat → attachSelection", () => {
  const avail = new Set([
    "workbench.action.chat.attachSelection",
    "workbench.action.chat.addToChatAction",
    "workbench.action.chat.open",
  ]);
  assert.equal(pickChatTrigger(avail), "workbench.action.chat.attachSelection");
});

test("Cursor add-to-chat → composer.startComposerPromptFromSelection", () => {
  const avail = new Set([
    "composer.startComposerPromptFromSelection",
    "aichat.newchataction",
    "glass.insertSelectionIntoGlassComposer",
    "workbench.action.chat.addToChatAction",
    "workbench.action.chat.open",
  ]);
  assert.equal(pickChatTrigger(avail), "composer.startComposerPromptFromSelection");
});

test("add-to-chat falls back to opening the chat panel", () => {
  assert.equal(pickChatTrigger(new Set(["workbench.action.chat.open"])), "workbench.action.chat.open");
  assert.equal(pickChatTrigger(new Set(["unrelated"])), null);
});

test("pickAiAccept finds the first available accept command", () => {
  assert.equal(
    pickAiAccept(new Set(["composer.acceptComposerStep"])),
    "composer.acceptComposerStep"
  );
  assert.equal(pickAiAccept(new Set(["unrelated"])), null);
});

if (failed > 0) {
  console.error(`\n${failed} aiCommands test(s) FAILED`);
  process.exit(1);
}
console.log("aiCommands tests passed");

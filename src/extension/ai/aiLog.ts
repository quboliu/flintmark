import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

// Tracing for the AI Selection Bridge: every hop (message received → selection
// relocated → which native command fired) goes to a "Flintmark AI" output
// channel AND a file mirror (LOG_FILE), so a run can be inspected outside the
// editor UI.
//
// OFF BY DEFAULT in the shipped extension — automatic tracing only runs when the
// user opts in via the `ofm.ai.debugLog` setting (keeps the package quiet and
// avoids writing to /tmp during normal use). Explicit user-invoked diagnostics
// (ofm.dumpAiCommands) always write, via aiLogForce().
let channel: vscode.OutputChannel | null = null;

/** Plain-text mirror of the channel; readable without the Output panel. */
export const LOG_FILE = path.join(os.tmpdir(), "flintmark-ai.log");

function chan(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel("Flintmark AI");
  return channel;
}

function debugLogEnabled(): boolean {
  return vscode.workspace.getConfiguration("ofm").get<boolean>("ai.debugLog") === true;
}

function write(msg: string): void {
  const line = `${new Date().toISOString().slice(11, 23)}  ${msg}`;
  chan().appendLine(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    /* best-effort file mirror */
  }
}

/** Trace a bridge hop — no-op unless `ofm.ai.debugLog` is enabled. */
export function aiLog(msg: string): void {
  if (debugLogEnabled()) write(msg);
}

/** Always write — for explicit, user-invoked diagnostics (e.g. dumpAiCommands). */
export function aiLogForce(msg: string): void {
  write(msg);
}

/** Reveal the AI log channel (bound to ofm.showAiLog). */
export function showAiLog(): void {
  if (!debugLogEnabled()) {
    chan().appendLine(
      "(AI debug logging is OFF — enable the `ofm.ai.debugLog` setting to trace AI actions, then retry.)"
    );
  }
  chan().show(true);
}

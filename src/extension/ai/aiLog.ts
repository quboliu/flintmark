import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

// A dedicated output channel that traces every hop of the AI Selection Bridge.
// The round-trip ends in the HOST's native AI (which we can't observe headless),
// so this trace is how we — and the user — see exactly where a click lands or
// breaks: message received → selection relocated → which native command fired.
//
// We ALSO tee the trace to a file (LOG_FILE) so it can be read OUTSIDE the
// editor UI — both for headless verification (drive the button, read the file)
// and so a manual tester's run can be inspected without copy-pasting.
let channel: vscode.OutputChannel | null = null;

/** Plain-text mirror of the channel; readable without the Output panel. */
export const LOG_FILE = path.join(os.tmpdir(), "flintmark-ai.log");

function chan(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel("Flintmark AI");
  return channel;
}

/** Append one timestamped line to the channel AND the on-disk mirror. */
export function aiLog(msg: string): void {
  const line = `${new Date().toISOString().slice(11, 23)}  ${msg}`;
  chan().appendLine(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    /* best-effort file mirror */
  }
}

/** Reveal the AI log channel (bound to ofm.showAiLog). */
export function showAiLog(): void {
  chan().show(true);
}

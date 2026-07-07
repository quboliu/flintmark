import type * as vscode from "vscode";

const suppressedUntil = new Map<string, number>();

export function suppressAutoSourceReveal(uri: vscode.Uri, ms = 2500): void {
  suppressedUntil.set(uri.toString(), Date.now() + ms);
}

export function isAutoSourceRevealSuppressed(uri: vscode.Uri): boolean {
  const key = uri.toString();
  const until = suppressedUntil.get(key) ?? 0;
  if (until <= Date.now()) {
    suppressedUntil.delete(key);
    return false;
  }
  return true;
}

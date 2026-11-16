// Node filesystem boundary for the driver test's synthetic file:// workspace.
// Other tests retain the real filesystem; custom:// uses the VS Code boundary.
import { workspace, Uri, FileType } from "./workspaceIndexVscode";

export async function stat(path: string) {
  const value = await workspace.fs.stat(Uri.file(path));
  return { isDirectory: () => (value.type & FileType.Directory) !== 0 };
}

export async function readdir(path: string) {
  return (await workspace.fs.readDirectory(Uri.file(path))).map(([name, type]) => ({
    name,
    isFile: () => (type & FileType.File) !== 0,
    isDirectory: () => (type & FileType.Directory) !== 0,
  }));
}

export async function readFile(path: string) {
  return workspace.fs.readFile(Uri.file(path));
}

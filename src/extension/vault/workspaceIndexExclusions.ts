import { Minimatch } from "minimatch";

export const DEFAULT_INDEX_EXCLUDES = [
  "**/{.git,node_modules,.obsidian,.trash,.cache,Library,.claude,.codex,.npm,.cargo,.rustup,.vscode,__pycache__,.venv,dist,target}/**",
  "**/.local/share/**",
];

/** One root-relative policy for search results and watcher hints alike. */
export class WorkspaceIndexExclusions {
  readonly glob: string | undefined;
  private readonly matchers: Minimatch[];

  constructor(patterns: readonly string[]) {
    const unique = [...new Set(patterns.filter((pattern) => pattern.length > 0))];
    this.glob = unique.length === 0 ? undefined : unique.length === 1 ? unique[0] : `{${unique.join(",")}}`;
    this.matchers = unique.map((pattern) => new Minimatch(pattern, {
      dot: true, nonegate: true, nocomment: true, noext: true,
    }));
  }

  excludes(relativePath: string): boolean {
    // Matching ancestors also handles a configuration entry such as "build"
    // or "**/private": excluding a directory excludes all its descendants.
    for (let path = relativePath; path; path = path.slice(0, Math.max(0, path.lastIndexOf("/")))) {
      if (this.matchers.some((matcher) => matcher.match(path) || matcher.match(path + "/"))) return true;
    }
    return false;
  }
}

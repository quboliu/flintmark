import * as vscode from "vscode";
import type { TodoInfo } from "./documentStructureParser";
import { DocumentStructureService } from "./documentStructureService";
import type { RevealHost } from "./outlineView";

type TodoTarget = TodoInfo & { uri: vscode.Uri; version: number };

function todoIcon(status: string): vscode.ThemeIcon {
  switch (status) {
    case "x":
    case "X":
      return new vscode.ThemeIcon("pass-filled");
    case "/":
      return new vscode.ThemeIcon("loading~spin");
    case "-":
      return new vscode.ThemeIcon("circle-slash");
    case ">":
      return new vscode.ThemeIcon("debug-step-over");
    case "?":
      return new vscode.ThemeIcon("question");
    case " ":
      return new vscode.ThemeIcon("circle-large-outline");
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
}

class TodoItem extends vscode.TreeItem {
  constructor(target: TodoTarget) {
    super(target.text || "(empty todo)", vscode.TreeItemCollapsibleState.None);
    this.iconPath = todoIcon(target.status);
    this.description = `[${target.status}] · L${target.line + 1}`;
    this.tooltip = `${target.text || "(empty todo)"}\nLine ${target.line + 1}`;
    this.contextValue = "ofmTodo";
    this.command = {
      command: "ofm.gotoTodo",
      title: "Go to todo",
      arguments: [target],
    };
  }
}

class TodoProvider implements vscode.TreeDataProvider<TodoItem | vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly structures: DocumentStructureService) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(item: TodoItem | vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): (TodoItem | vscode.TreeItem)[] {
    const snapshot = this.structures.getActiveSnapshot();
    if (!snapshot) return [placeholder("Open a Markdown note to see its todos")];
    if (snapshot.todos.length === 0) return [placeholder("No todos")];

    const uri = vscode.Uri.parse(snapshot.uri);
    return snapshot.todos.map(
      (todo) => new TodoItem({ ...todo, uri, version: snapshot.version })
    );
  }
}

function placeholder(text: string): vscode.TreeItem {
  const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon("info");
  return item;
}

/** Register the active-document Todo aggregation and source navigation view. */
export function registerTodoView(
  context: vscode.ExtensionContext,
  host: RevealHost,
  structures: DocumentStructureService
): void {
  const provider = new TodoProvider(structures);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("ofm.todos", provider),
    structures.onDidChange(() => provider.refresh()),
    vscode.commands.registerCommand("ofm.refreshTodos", () => {
      structures.refreshActive();
    }),
    vscode.commands.registerCommand("ofm.gotoTodo", async (target: TodoTarget) => {
      if (!target?.uri) return;
      const position = structures.resolveTodo(target.uri, target);
      if (position) {
        await host.revealPositionInDocument(
          target.uri,
          position.line,
          position.character
        );
      }
    })
  );
}

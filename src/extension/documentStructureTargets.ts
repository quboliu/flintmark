import type { DocumentStructureSnapshot } from "./documentStructureCache";

export interface TodoTargetIdentity {
  version: number;
  status: string;
  text: string;
  line: number;
  character: number;
  markerFrom: number;
}

export interface HeadingTargetIdentity {
  version: number;
  level: number;
  text: string;
  line: number;
}

export interface SourcePosition {
  line: number;
  character: number;
}

export function resolveTodoTarget(
  snapshot: DocumentStructureSnapshot,
  item: TodoTargetIdentity
): SourcePosition | undefined {
  if (snapshot.version === item.version) {
    return { line: item.line, character: item.character };
  }

  const exact = snapshot.todos.find((todo) => todo.markerFrom === item.markerFrom);
  if (exact && exact.status === item.status && exact.text === item.text) {
    return { line: exact.line, character: exact.character };
  }

  const candidates = snapshot.todos.filter(
    (todo) => todo.status === item.status && todo.text === item.text
  );
  const nearest = candidates.reduce<(typeof candidates)[number] | undefined>(
    (best, candidate) =>
      !best || Math.abs(candidate.line - item.line) < Math.abs(best.line - item.line)
        ? candidate
        : best,
    undefined
  );
  return nearest ? { line: nearest.line, character: nearest.character } : undefined;
}

export function resolveHeadingTarget(
  snapshot: DocumentStructureSnapshot,
  item: HeadingTargetIdentity
): SourcePosition | undefined {
  if (snapshot.version === item.version) return { line: item.line, character: 0 };

  const candidates = snapshot.headings.filter(
    (heading) => heading.level === item.level && heading.text === item.text
  );
  const nearest = candidates.reduce<(typeof candidates)[number] | undefined>(
    (best, candidate) =>
      !best || Math.abs(candidate.line - item.line) < Math.abs(best.line - item.line)
        ? candidate
        : best,
    undefined
  );
  return nearest ? { line: nearest.line, character: 0 } : undefined;
}

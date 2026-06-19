// Re-exports — shared/types.ts is the canonical import for shared types.
// All actual type definitions live in protocol.ts (message types) and ranges.ts (position helpers).
// This file exists as the documented entry point per docs/03-solution-design.md section 3.

export type {
  DocVersion,
  DocChange,
  SourceRange,
  BlockType,
  LiveSelection,
  Settings,
  Origin,
  WebviewMsg,
  HostMsg,
} from "./protocol";
export { offsetToPosition, positionToOffset, lineCount } from "./ranges";

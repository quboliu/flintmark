// Compatibility wrapper for callers/tests that only need headings. The real
// scan is shared with Todo via documentStructureParser.
import {
  parseDocumentStructure,
  type HeadingInfo,
} from "./documentStructureParser";

export type { HeadingInfo };

export function parseHeadings(text: string): HeadingInfo[] {
  return parseDocumentStructure(text).headings;
}

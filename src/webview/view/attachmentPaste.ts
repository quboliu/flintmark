// Webview side of image paste/drop. Detects an image in a paste/drop event,
// reads it to base64, and asks the host to save it (the host writes the file and
// replies with the embed name). When the reply arrives, the embed `![[name]]` is
// inserted at the position captured when the paste/drop happened.
import { EditorView } from "@codemirror/view";

export interface SaveAttachmentPayload {
  requestId: number;
  filename: string;
  mime: string;
  dataBase64: string;
}
export type AttachmentPoster = (payload: SaveAttachmentPayload) => void;

/** Size cap mirrored from the host — checked BEFORE reading the file so a huge
 *  paste/drop can't freeze the webview building a base64 string. */
export const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;

let requestCounter = 0;
/** requestId → document range the embed should replace on reply (a caret when
 *  from === to). */
const pendingInserts = new Map<number, { from: number; to: number }>();

function isImageFile(f: File | null | undefined): f is File {
  return !!f && typeof f.type === "string" && f.type.startsWith("image/");
}

/** First image File in a paste event's clipboard, or null. */
export function imageFromPaste(e: ClipboardEvent): File | null {
  const cd = e.clipboardData;
  if (!cd) return null;
  for (const item of Array.from(cd.items ?? [])) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (isImageFile(f)) return f;
    }
  }
  for (const f of Array.from(cd.files ?? [])) if (isImageFile(f)) return f;
  return null;
}

/** First image File in a drop event, or null. */
export function imageFromDrop(e: DragEvent): File | null {
  const dt = e.dataTransfer;
  if (!dt) return null;
  for (const f of Array.from(dt.files ?? [])) if (isImageFile(f)) return f;
  return null;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/**
 * Read an image File and ask the host to save it. The target range is captured
 * now (the embed replaces it once the host replies — a selection for paste, the
 * drop point for drop).
 */
export function queueImageSave(
  file: File,
  range: { from: number; to: number },
  post: AttachmentPoster
): boolean {
  // Reject oversize BEFORE reading — don't build a ~32 MB base64 string for a
  // file the host will refuse anyway.
  if (file.size > MAX_ATTACHMENT_BYTES) {
    console.warn(`[ofm] image too large to attach: ${file.size} bytes`);
    return false;
  }
  const requestId = ++requestCounter;
  pendingInserts.set(requestId, range);
  void file
    .arrayBuffer()
    .then((buf) => {
      post({
        requestId,
        filename: file.name || "",
        mime: file.type,
        dataBase64: toBase64(new Uint8Array(buf)),
      });
    })
    .catch(() => {
      pendingInserts.delete(requestId);
    });
  return true;
}

/** Insert the embed `![[name]]` once the host confirms the save. */
export function applyAttachmentSaved(
  view: EditorView,
  requestId: number,
  embed: string
): void {
  const stored = pendingInserts.get(requestId);
  pendingInserts.delete(requestId);
  const len = view.state.doc.length;
  const main = view.state.selection.main;
  // Use the captured range (clamped); fall back to the current selection.
  let from = stored ? Math.min(stored.from, len) : main.from;
  let to = stored ? Math.min(stored.to, len) : main.to;
  if (from > to) [from, to] = [to, from];
  const insert = `![[${embed}]]`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    userEvent: "input.paste",
    scrollIntoView: true,
  });
}

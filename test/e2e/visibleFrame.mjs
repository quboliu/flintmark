// A retained webview can report visible content inside a hidden outer iframe.
// Check every frame boundary before selecting a user-facing editor.
export async function isVisibleFrame(frame) {
  try {
    for (let child = frame; child.parentFrame(); child = child.parentFrame()) {
      const element = await child.frameElement();
      try {
        if (!await element.isVisible()) {
          console.log("HIDDEN_FRAME_SKIPPED", JSON.stringify({url:frame.url(),boundary:child.url()}));
          return false;
        }
      } finally { await element.dispose(); }
    }
    return true;
  } catch { return false; } // Frames can detach while switching editors.
}

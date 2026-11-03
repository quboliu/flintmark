import assert from "node:assert/strict";

// A virtualized DOM has no stable relationship between DOM index and source
// line number. Reveal the source target without moving the caret or focusing
// the editor; the caller still performs the real pointer/keyboard interaction.
export async function revealSource(frame, needle) {
  const target = await frame.evaluate((needle) => {
    const view = document.querySelector(".cm-content")?.cmTile?.root?.view;
    if (!view) throw new Error("Missing CodeMirror view");
    const source = view.state.doc.toString();
    const pos = source.indexOf(needle);
    if (pos < 0) throw new Error(`Missing source target: ${needle}`);
    if (source.indexOf(needle, pos + needle.length) >= 0) {
      throw new Error(`Ambiguous source target: ${needle}`);
    }
    const selection = view.state.selection.toJSON();
    view.dispatch({ effects: view.constructor.scrollIntoView(pos, { y: "center" }) });
    return { from: view.state.doc.lineAt(pos).from, selection };
  }, needle);
  const selection = await frame.evaluate(() =>
    document.querySelector(".cm-content").cmTile.root.view.state.selection.toJSON()
  );
  assert.deepEqual(selection, target.selection, "viewport setup must preserve selection");
  return target.from;
}

export async function sourceLine(frame, sourceNeedle, renderedNeedle = sourceNeedle) {
  const from = await revealSource(frame, sourceNeedle);
  const lines = frame.locator(".cm-line").filter({ hasText: renderedNeedle });
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const count = await lines.count();
    for (let i = 0; i < count; i++) {
      const line = lines.nth(i);
      const matches = await line.evaluate((element, from) => {
        const view = document.querySelector(".cm-content").cmTile.root.view;
        return view.state.doc.lineAt(view.posAtDOM(element, 0)).from === from;
      }, from).catch(() => false);
      if (matches) {
        await line.scrollIntoViewIfNeeded({ timeout: 5000 });
        return line;
      }
    }
    await frame.page().waitForTimeout(25);
  }
  throw new Error(`Source line did not mount: ${sourceNeedle}`);
}

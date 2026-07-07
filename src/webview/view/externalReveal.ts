import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

export const setExternalRevealRange = StateEffect.define<{
  from: number;
  to: number;
} | null>();

const externalRevealMark = Decoration.mark({
  class: "ofm-external-search-hit",
});

export const externalRevealField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    let receivedReveal = false;

    for (const effect of tr.effects) {
      if (!effect.is(setExternalRevealRange)) continue;
      receivedReveal = true;
      const range = effect.value;
      if (!range || range.from === range.to) {
        next = Decoration.none;
        continue;
      }
      next = Decoration.set(
        [externalRevealMark.range(range.from, range.to)],
        true
      );
    }

    // Once the user moves the caret or changes selection, the external search
    // hit is no longer the active navigation target.
    if (!receivedReveal && tr.selection) return Decoration.none;
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

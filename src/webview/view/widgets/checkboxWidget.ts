// Interactive task checkbox: replaces a Lezer `TaskMarker` ([ ] / [x]) with a
// real <input type=checkbox>. Clicking it asks the host (via a Facet-provided
// callback) to toggle the marker in the Source of Truth; the resulting document
// change echoes back and re-renders the checkbox. The checkbox is ALWAYS shown
// (not reveal-gated) — matching Obsidian, where the box stays while you edit the
// task text.
import { EditorView, WidgetType } from "@codemirror/view";
import { Facet } from "@codemirror/state";

export type TaskToggle = (range: { from: number; to: number }) => void;

/** Provides the host-toggle callback to checkbox widgets. */
export const taskToggleFacet = Facet.define<TaskToggle, TaskToggle | null>({
  combine: (values) => (values.length > 0 ? values[0] : null),
});

export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
    /** The single char inside `[ ]` (' ', 'x', '/', '-', '>', …) — drives the
     *  theme's per-type task styling via the data-task attribute. */
    readonly taskChar: string = " "
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return (
      other.checked === this.checked &&
      other.from === this.from &&
      other.to === this.to &&
      other.taskChar === this.taskChar
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "ofm-task-checkbox task-list-item-checkbox";
    box.setAttribute("data-task", this.taskChar);
    box.setAttribute(
      "aria-label",
      this.checked ? "Completed task" : "Incomplete task"
    );
    // Keep editor focus/selection stable; handle the toggle ourselves.
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const toggle = view.state.facet(taskToggleFacet);
      toggle?.({ from: this.from, to: this.to });
    });
    return box;
  }

  ignoreEvent(): boolean {
    // Our own listeners handle clicks; the editor should not treat them as
    // cursor placement.
    return true;
  }
}

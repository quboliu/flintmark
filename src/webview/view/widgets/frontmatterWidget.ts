// Block widget that renders parsed YAML frontmatter as an Obsidian-style
// Properties panel (key column + value; list/tags as chips). Read-only display —
// clicking it places the cursor so the raw YAML reveals for editing (the usual
// reveal model). Styling lives in markdownTheme (the CM6 theme layer).
import { WidgetType } from "@codemirror/view";
import type { FrontmatterProp } from "../frontmatter";

export class FrontmatterWidget extends WidgetType {
  constructor(readonly props: FrontmatterProp[]) {
    super();
  }

  eq(other: FrontmatterWidget): boolean {
    return JSON.stringify(other.props) === JSON.stringify(this.props);
  }

  toDOM(): HTMLElement {
    const root = document.createElement("div");
    root.className = "ofm-properties";
    root.setAttribute("aria-label", "Note properties");

    for (const p of this.props) {
      const row = document.createElement("div");
      row.className = "ofm-prop-row";

      const key = document.createElement("div");
      key.className = "ofm-prop-key";
      key.textContent = p.key;
      row.appendChild(key);

      const val = document.createElement("div");
      val.className = "ofm-prop-value";
      if (p.list) {
        if (p.items.length === 0) {
          val.classList.add("ofm-prop-empty");
          val.textContent = "—";
        } else {
          for (const item of p.items) {
            const chip = document.createElement("span");
            chip.className = "ofm-prop-chip";
            chip.textContent = item;
            val.appendChild(chip);
          }
        }
      } else {
        const text = p.items[0] ?? "";
        if (text === "") {
          val.classList.add("ofm-prop-empty");
          val.textContent = "—";
        } else {
          val.textContent = text;
        }
      }
      row.appendChild(val);
      root.appendChild(row);
    }

    return root;
  }

  // Let clicks reach the editor so the cursor enters the frontmatter and the raw
  // YAML reveals for editing (read-only panel; edit via source).
  ignoreEvent(): boolean {
    return false;
  }
}

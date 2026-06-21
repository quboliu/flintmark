// Block widget that renders parsed YAML frontmatter as an Obsidian-style
// Properties panel: a "Properties" header, then one row per key — a leading
// type icon, the key, and the value (list/tags as chips). Read-only display;
// the raw YAML is edited in the Code view (the </> toggle), mirroring Obsidian's
// Source mode. Styling lives in markdownTheme (the CM6 theme layer).
import { WidgetType } from "@codemirror/view";
import { propIconType, type FrontmatterProp, type PropIcon } from "../frontmatter";

// Lucide-style glyphs (Obsidian uses Lucide), drawn with currentColor stroke so
// they follow the muted text color. Kept inline to avoid any icon-font dependency.
const ICON_SVG: Record<PropIcon, string> = {
  text: '<line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  tags: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  date: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
};

function iconEl(type: PropIcon): HTMLElement {
  const span = document.createElement("span");
  span.className = "ofm-prop-icon";
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_SVG[type]}</svg>`;
  return span;
}

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

    const header = document.createElement("div");
    header.className = "ofm-properties-header";
    header.textContent = "Properties";
    root.appendChild(header);

    for (const p of this.props) {
      const row = document.createElement("div");
      row.className = "ofm-prop-row";

      row.appendChild(iconEl(propIconType(p)));

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

  // Let clicks reach the editor so the cursor can be placed; the panel stays put
  // (it's always shown — raw YAML is edited in the Code view).
  ignoreEvent(): boolean {
    return false;
  }
}

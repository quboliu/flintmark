import assert from "node:assert";
import { EditorState } from "@codemirror/state";
import { ofmMarkdown } from "../../src/webview/kernel/obsidianSyntax";
import { buildBlockWidgets } from "../../src/webview/view/markdownDecorations";
import {
  planTableMeasurementPublication,
  tableSourcesWithinMeasurementBudget,
  unmeasuredTableSources,
  setTableMeasurements,
  tableMeasurementsField,
} from "../../src/webview/view/tableMeasurements";
import { TableWidget } from "../../src/webview/view/widgets/tableWidget";

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log("  ✓ " + name);
  } catch (error) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (error as Error).message);
  }
}

const TABLE = "| Header | Value |\n| --- | --- |\n| long cell | content |";

function stateWithMeasurement(height?: number): EditorState {
  let state = EditorState.create({ doc: TABLE + "\n", extensions: [ofmMarkdown(), tableMeasurementsField] });
  if (height !== undefined) {
    state = state.update({
      effects: setTableMeasurements.of({
        signature: "layout-a",
        measurements: [{ source: TABLE, height }],
        replace: true,
      }),
    }).state;
  }
  return state;
}

function tables(state: EditorState): TableWidget[] {
  const out: TableWidget[] = [];
  buildBlockWidgets(state).between(0, state.doc.length, (_from, _to, value) => {
    const widget = value.spec.widget;
    if (widget instanceof TableWidget) out.push(widget);
  });
  return out;
}

test("unmeasured tables stay in the Markdown source flow", () => {
  assert.equal(tables(stateWithMeasurement()).length, 0);
});

test("a reliable layout measurement enables the table block widget", () => {
  const found = tables(stateWithMeasurement(321.25));
  assert.equal(found.length, 1);
  assert.equal(found[0].estimatedHeight, 322, "published heights are rounded up");
});

test("TableWidget equality includes height and layout version", () => {
  const a = new TableWidget(TABLE, 0, 322, 4);
  assert.equal(a.eq(new TableWidget(TABLE, 0, 322, 4)), true);
  assert.equal(a.eq(new TableWidget(TABLE, 0, 323, 4)), false);
  assert.equal(a.eq(new TableWidget(TABLE, 0, 322, 5)), false);
});

test("TableWidget rejects non-positive or non-finite estimated heights", () => {
  assert.throws(() => new TableWidget(TABLE, 0, 0, 1));
  assert.throws(() => new TableWidget(TABLE, 0, Number.NaN, 1));
});

test("a new layout signature waits for every table before one atomic replacement", () => {
  const active = new Map([
    ["table-a", 100],
    ["table-b", 200],
  ]);
  assert.deepEqual(
    planTableMeasurementPublication(
      "layout-old",
      active,
      "layout-new",
      ["table-a", "table-b"],
      new Map([["table-a", 130]])
    ),
    { kind: "wait", measurements: [] },
    "partial new-layout measurements must not clear or replace old widgets"
  );
  assert.deepEqual(
    planTableMeasurementPublication(
      "layout-old",
      active,
      "layout-new",
      ["table-a", "table-b"],
      new Map([
        ["table-a", 130],
        ["table-b", 240],
      ])
    ),
    {
      kind: "replace",
      measurements: [
        { source: "table-a", height: 130 },
        { source: "table-b", height: 240 },
      ],
    }
  );
});

test("same-layout new tables publish incrementally without discarding known heights", () => {
  assert.deepEqual(
    planTableMeasurementPublication(
      "layout-a",
      new Map([["existing", 100]]),
      "layout-a",
      ["existing", "added"],
      new Map([["added", 80]])
    ),
    { kind: "incremental", measurements: [{ source: "added", height: 80 }] }
  );
});

test("a partial signature transition leaves the old widget mounted until atomic swap", () => {
  let state = stateWithMeasurement(100);
  const sources = [TABLE, "| Other |\n| --- |\n| row |"];
  const partial = planTableMeasurementPublication(
    "layout-a",
    new Map([[TABLE, 100]]),
    "layout-b",
    sources,
    new Map([[TABLE, 150]])
  );
  assert.equal(partial.kind, "wait");
  assert.equal(tables(state)[0].estimatedHeight, 100, "no empty effect may tear down the widget");

  const complete = planTableMeasurementPublication(
    "layout-a",
    new Map([[TABLE, 100]]),
    "layout-b",
    sources,
    new Map([
      [TABLE, 150],
      [sources[1], 90],
    ])
  );
  assert.equal(complete.kind, "replace");
  if (complete.kind !== "replace") throw new Error("expected an atomic replacement");
  state = state.update({
    effects: setTableMeasurements.of({
      signature: "layout-b",
      measurements: complete.measurements,
      replace: true,
    }),
  }).state;
  assert.equal(tables(state)[0].estimatedHeight, 150);
});

test("the state field rejects a partial batch carrying a different signature", () => {
  let state = stateWithMeasurement(100);
  state = state.update({
    effects: setTableMeasurements.of({
      signature: "layout-b",
      measurements: [{ source: TABLE, height: 150 }],
      replace: false,
    }),
  }).state;
  assert.equal(tables(state)[0].estimatedHeight, 100);
});

test("2,049 unique tables converge while the overflow table stays in source", () => {
  const sources = Array.from({ length: 2_049 }, (_, index) => `table-${index}`);
  const measurable = tableSourcesWithinMeasurementBudget(sources);
  const heights = new Map(measurable.map((source, index) => [source, index + 1]));

  assert.equal(measurable.length, 2_048);
  assert.equal(measurable.includes(sources[2_048]), false, "overflow remains unknown");
  assert.equal(
    unmeasuredTableSources(sources, (source) => heights.has(source)).length,
    0,
    "pending reaches zero so no follow-up animation frame is needed"
  );
  assert.equal(
    planTableMeasurementPublication("", new Map(), "layout-a", measurable, heights).kind,
    "replace"
  );
});

if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll table measurement tests passed");

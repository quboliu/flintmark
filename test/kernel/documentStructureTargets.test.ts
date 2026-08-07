import assert from "node:assert";
import type { DocumentStructureSnapshot } from "../../src/extension/documentStructureCache";
import {
  resolveHeadingTarget,
  resolveTodoTarget,
} from "../../src/extension/documentStructureTargets";

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

const snapshot: DocumentStructureSnapshot = {
  uri: "file:///note.md",
  version: 4,
  headings: [{ level: 2, text: "Section", line: 8 }],
  todos: [
    { status: " ", text: "same", line: 5, character: 2, markerFrom: 40, markerTo: 43 },
    { status: " ", text: "same", line: 20, character: 4, markerFrom: 180, markerTo: 183 },
  ],
};

test("same-version Todo targets retain their exact source position", () => {
  assert.deepEqual(
    resolveTodoTarget(snapshot, {
      version: 4,
      status: " ",
      text: "same",
      line: 99,
      character: 7,
      markerFrom: 999,
    }),
    { line: 99, character: 7 }
  );
});

test("same-version heading targets retain their exact source line", () => {
  assert.deepEqual(
    resolveHeadingTarget(snapshot, {
      version: 4,
      level: 6,
      text: "stale identity is irrelevant for the current version",
      line: 37,
    }),
    { line: 37, character: 0 }
  );
});

test("stale Todo targets keep an unchanged exact marker identity", () => {
  assert.deepEqual(
    resolveTodoTarget(snapshot, {
      version: 3,
      status: " ",
      text: "same",
      line: 100,
      character: 0,
      markerFrom: 40,
    }),
    { line: 5, character: 2 }
  );
});

test("stale duplicate Todo targets resolve to the nearest current occurrence", () => {
  assert.deepEqual(
    resolveTodoTarget(snapshot, {
      version: 3,
      status: " ",
      text: "same",
      line: 18,
      character: 2,
      markerFrom: 150,
    }),
    { line: 20, character: 4 }
  );
});

test("a reused marker offset cannot redirect a stale Todo to changed content", () => {
  const changedAtOldOffset: DocumentStructureSnapshot = {
    ...snapshot,
    version: 5,
    todos: [
      { status: "x", text: "replacement", line: 5, character: 2, markerFrom: 40, markerTo: 43 },
      { status: " ", text: "original", line: 12, character: 6, markerFrom: 100, markerTo: 103 },
    ],
  };
  assert.deepEqual(
    resolveTodoTarget(changedAtOldOffset, {
      version: 4,
      status: " ",
      text: "original",
      line: 5,
      character: 2,
      markerFrom: 40,
    }),
    { line: 12, character: 6 }
  );
});

test("stale Todo fallback requires both status and text", () => {
  assert.equal(
    resolveTodoTarget(snapshot, {
      version: 3,
      status: "x",
      text: "same",
      line: 20,
      character: 2,
      markerFrom: 999,
    }),
    undefined
  );
  assert.equal(
    resolveTodoTarget(snapshot, {
      version: 3,
      status: " ",
      text: "different",
      line: 20,
      character: 2,
      markerFrom: 999,
    }),
    undefined
  );
});

test("equidistant duplicate Todo targets resolve deterministically to the first", () => {
  assert.deepEqual(
    resolveTodoTarget(snapshot, {
      version: 3,
      status: " ",
      text: "same",
      line: 12.5,
      character: 0,
      markerFrom: 999,
    }),
    { line: 5, character: 2 }
  );
});

test("stale headings require level and text and choose the nearest duplicate", () => {
  const headings: DocumentStructureSnapshot = {
    ...snapshot,
    version: 9,
    headings: [
      { level: 2, text: "Section", line: 4 },
      { level: 1, text: "Section", line: 15 },
      { level: 2, text: "Other", line: 18 },
      { level: 2, text: "Section", line: 30 },
    ],
  };
  assert.deepEqual(
    resolveHeadingTarget(headings, {
      version: 8,
      level: 2,
      text: "Section",
      line: 27,
    }),
    { line: 30, character: 0 }
  );
  assert.equal(
    resolveHeadingTarget(headings, {
      version: 8,
      level: 3,
      text: "Section",
      line: 15,
    }),
    undefined
  );
  assert.equal(
    resolveHeadingTarget(headings, {
      version: 8,
      level: 2,
      text: "Missing",
      line: 18,
    }),
    undefined
  );
});

test("equidistant duplicate headings resolve deterministically to the first", () => {
  const headings: DocumentStructureSnapshot = {
    ...snapshot,
    version: 9,
    headings: [
      { level: 2, text: "Section", line: 4 },
      { level: 2, text: "Section", line: 10 },
    ],
  };
  assert.deepEqual(
    resolveHeadingTarget(headings, {
      version: 8,
      level: 2,
      text: "Section",
      line: 7,
    }),
    { line: 4, character: 0 }
  );
});

test("removed stale targets do not navigate to unrelated content", () => {
  assert.equal(
    resolveTodoTarget(snapshot, {
      version: 3,
      status: "x",
      text: "removed",
      line: 2,
      character: 2,
      markerFrom: 10,
    }),
    undefined
  );
  assert.equal(
    resolveHeadingTarget(snapshot, {
      version: 3,
      level: 1,
      text: "Removed",
      line: 0,
    }),
    undefined
  );
});

if (failed > 0) {
  console.error(`\n${failed} document structure target test(s) FAILED`);
  process.exit(1);
}
console.log("document structure target tests passed");

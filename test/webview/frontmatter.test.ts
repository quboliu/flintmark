// L1 unit tests for the minimal frontmatter YAML parser (the Properties panel).
// Pure, no CM6/DOM. Falls back to null on anything beyond the supported subset.
import assert from "node:assert";
import {
  findFrontmatterRange,
  parseFrontmatter,
  propIconType,
} from "../../src/webview/view/frontmatter";

let failed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (e as Error).message);
  }
}

test("scalar key: value", () => {
  assert.deepEqual(parseFrontmatter("---\ntype: blog\n---"), [
    { key: "type", items: ["blog"], list: false },
  ]);
});

test("findFrontmatterRange includes the newline after the closing fence", () => {
  const text = "---\ntitle: Features\n---\n# Features";
  assert.deepEqual(findFrontmatterRange(text), { from: 0, to: 24 });
  assert.equal(text.slice(24), "# Features");
});

test("findFrontmatterRange supports ... closing fences and CRLF", () => {
  const text = "---\r\ntitle: Features\r\n...\r\nbody";
  const range = findFrontmatterRange(text);
  assert.deepEqual(range, { from: 0, to: 27 });
  assert.equal(text.slice(range!.to), "body");
});

test("findFrontmatterRange only matches a leading closed block", () => {
  assert.equal(findFrontmatterRange("# Title\n---\ntitle: no\n---"), null);
  assert.equal(findFrontmatterRange("---\ntitle: no close\nbody"), null);
});

test("block list", () => {
  assert.deepEqual(parseFrontmatter("---\ntags:\n  - a\n  - b\n---"), [
    { key: "tags", items: ["a", "b"], list: true },
  ]);
});

test("inline array", () => {
  assert.deepEqual(parseFrontmatter("---\ntags: [a, b, c]\n---"), [
    { key: "tags", items: ["a", "b", "c"], list: true },
  ]);
});

test("empty value", () => {
  assert.deepEqual(parseFrontmatter("---\ndomain:\n---"), [
    { key: "domain", items: [], list: false },
  ]);
});

test("quoted scalar + quoted list items are unquoted", () => {
  assert.deepEqual(parseFrontmatter('---\ntitle: "Hello: World"\ntags: ["x", \'y\']\n---'), [
    { key: "title", items: ["Hello: World"], list: false },
    { key: "tags", items: ["x", "y"], list: true },
  ]);
});

test("a scalar value keeps its inner colon (e.g. a timestamp)", () => {
  assert.deepEqual(parseFrontmatter("---\ncreated: 2026-06-02T01:52:32\n---"), [
    { key: "created", items: ["2026-06-02T01:52:32"], list: false },
  ]);
});

test("list items keep their inner colon", () => {
  assert.deepEqual(parseFrontmatter("---\nevidence:\n  - Linux 6.15.7: kernel/sched/core.c\n---"), [
    { key: "evidence", items: ["Linux 6.15.7: kernel/sched/core.c"], list: true },
  ]);
});

test("the real-world multi-key frontmatter parses in order", () => {
  const fm = [
    "---",
    "title: CPU limit 不是 CPU 个数：cgroup 和 GOMAXPROCS 的边界",
    "domain:",
    "  - 10-技术/03-操作系统与Linux",
    "type: blog",
    "tags:",
    "  - cgroup",
    "  - go",
    "---",
  ].join("\n");
  assert.deepEqual(parseFrontmatter(fm), [
    { key: "title", items: ["CPU limit 不是 CPU 个数：cgroup 和 GOMAXPROCS 的边界"], list: false },
    { key: "domain", items: ["10-技术/03-操作系统与Linux"], list: true },
    { key: "type", items: ["blog"], list: false },
    { key: "tags", items: ["cgroup", "go"], list: true },
  ]);
});

test("inline array: quoted commas are not split", () => {
  assert.deepEqual(parseFrontmatter('---\naliases: ["Smith, Jane", "Janie"]\n---'), [
    { key: "aliases", items: ["Smith, Jane", "Janie"], list: true },
  ]);
});

test("block list: blank lines between items are tolerated", () => {
  assert.deepEqual(parseFrontmatter("---\ntags:\n  - a\n\n  - b\n---"), [
    { key: "tags", items: ["a", "b"], list: true },
  ]);
});

test("block list then blank then next key: both parse", () => {
  assert.deepEqual(parseFrontmatter("---\ntags:\n  - a\n\ntype: blog\n---"), [
    { key: "tags", items: ["a"], list: true },
    { key: "type", items: ["blog"], list: false },
  ]);
});

test("nested map (indented key) → null (fall back to raw)", () => {
  assert.equal(parseFrontmatter("---\nmeta:\n  nested: x\n---"), null);
});

test("no opening / closing fence → null", () => {
  assert.equal(parseFrontmatter("type: blog\n"), null);
  assert.equal(parseFrontmatter("---\ntype: blog\n"), null);
});

test("empty frontmatter → null", () => {
  assert.equal(parseFrontmatter("---\n---"), null);
});

test("propIconType: tags list → tags", () => {
  assert.equal(propIconType({ key: "tags", items: ["a"], list: true }), "tags");
  assert.equal(propIconType({ key: "tag", items: [], list: true }), "tags");
  assert.equal(propIconType({ key: "Tags", items: ["x"], list: true }), "tags");
});

test("propIconType: other list → list", () => {
  assert.equal(propIconType({ key: "domain", items: ["x"], list: true }), "list");
  assert.equal(propIconType({ key: "aliases", items: [], list: true }), "list");
});

test("propIconType: ISO date scalar → date", () => {
  assert.equal(propIconType({ key: "created", items: ["2026-06-21"], list: false }), "date");
  assert.equal(
    propIconType({ key: "updated", items: ["2026-06-21T01:52:32"], list: false }),
    "date",
  );
  assert.equal(propIconType({ key: "when", items: ["2026-06-21 09:00"], list: false }), "date");
});

test("propIconType: plain scalar / empty → text", () => {
  assert.equal(propIconType({ key: "title", items: ["epoll"], list: false }), "text");
  assert.equal(propIconType({ key: "status", items: ["verified"], list: false }), "text");
  assert.equal(propIconType({ key: "note", items: [], list: false }), "text");
  // 'tags' as a SCALAR (not a list) is text, not the tags glyph.
  assert.equal(propIconType({ key: "tags", items: ["one"], list: false }), "text");
});

if (failed > 0) {
  console.error(`\n${failed} frontmatter test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll frontmatter tests passed");

import assert from "node:assert";
import { parseDocumentStructure } from "../../src/extension/documentStructureParser";
import { DocumentStructureStore } from "../../src/extension/documentStructureStore";

let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log("  ✓ " + name);
  } catch (error) {
    failed++;
    console.error("  ✗ " + name + "\n      " + (error as Error).message);
  }
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function run(): Promise<void> {
  await test("Outline and Todo plus an edit burst produce one scan per version", async () => {
    let scans = 0;
    const published: Array<string | undefined> = [];
    const store = new DocumentStructureStore({
      initialActiveUri: "file:///a.md",
      onDidChange: (uri) => published.push(uri),
      parse: (text) => {
        scans++;
        return parseDocumentStructure(text);
      },
      refreshDelayMs: 10,
      maxRefreshDelayMs: 30,
    });

    const initial = { uri: "file:///a.md", version: 1, text: "# A\n- [ ] one\n" };
    const outline = store.get(initial);
    const todo = store.get(initial);
    assert.strictEqual(outline, todo);
    assert.equal(scans, 1);

    let latest = initial;
    for (let version = 2; version <= 6; version++) {
      latest = {
        uri: "file:///a.md",
        version,
        text: `# A\n- [ ] task-v${version}\n`,
      };
      store.scheduleDocumentChange(latest.uri, () => latest);
    }
    await wait(40);

    assert.equal(scans, 2, "five change events should collapse to one latest-version scan");
    assert.deepEqual(published, ["file:///a.md"]);
    assert.deepEqual(store.get(latest).todos.map((item) => item.text), ["task-v6"]);
    assert.equal(scans, 2, "tree consumers must reuse the published snapshot");
    store.dispose();
  });

  await test("switching documents cancels a pending old-document scan", async () => {
    let scans = 0;
    const published: Array<string | undefined> = [];
    const store = new DocumentStructureStore({
      initialActiveUri: "file:///a.md",
      onDidChange: (uri) => published.push(uri),
      parse: (text) => {
        scans++;
        return parseDocumentStructure(text);
      },
      refreshDelayMs: 15,
      maxRefreshDelayMs: 40,
    });

    store.scheduleDocumentChange("file:///a.md", () => ({
      uri: "file:///a.md",
      version: 2,
      text: "- [ ] stale A\n",
    }));
    store.setActive("file:///b.md", {
      uri: "file:///b.md",
      version: 1,
      text: "- [ ] current B\n",
    });
    await wait(50);

    assert.equal(scans, 1, "only the new active document may be scanned");
    assert.deepEqual(published, ["file:///b.md"]);
    assert.equal(
      store.setActive("file:///b.md", {
        uri: "file:///b.md",
        version: 1,
        text: "ignored duplicate active event",
      }),
      false
    );
    assert.equal(scans, 1, "duplicate tab/editor events must not rescan or republish");
    assert.deepEqual(published, ["file:///b.md"]);
    store.dispose();
  });

  await test("inactive-document edits do not scan or refresh the active panel", async () => {
    let scans = 0;
    let publishes = 0;
    const store = new DocumentStructureStore({
      initialActiveUri: "file:///active.md",
      onDidChange: () => publishes++,
      parse: (text) => {
        scans++;
        return parseDocumentStructure(text);
      },
      refreshDelayMs: 5,
    });
    store.scheduleDocumentChange("file:///background.md", () => ({
      uri: "file:///background.md",
      version: 2,
      text: "- [ ] background\n",
    }));
    await wait(20);
    assert.equal(scans, 0);
    assert.equal(publishes, 0);
    store.dispose();
  });

  await test("a late TextDocument open fills a same-URI placeholder exactly once", async () => {
    let scans = 0;
    const published: Array<string | undefined> = [];
    const store = new DocumentStructureStore({
      initialActiveUri: "file:///old.md",
      onDidChange: (uri) => published.push(uri),
      parse: (text) => {
        scans++;
        return parseDocumentStructure(text);
      },
    });

    assert.equal(store.setActive("file:///opening.md"), true);
    assert.equal(scans, 0, "the tab can become active before its document is loaded");
    assert.equal(
      store.setActive("file:///opening.md", {
        uri: "file:///opening.md",
        version: 1,
        text: "- [ ] loaded later\n",
      }),
      true
    );
    assert.equal(scans, 1);
    assert.deepEqual(published, ["file:///opening.md", "file:///opening.md"]);

    assert.equal(
      store.setActive("file:///opening.md", {
        uri: "file:///opening.md",
        version: 1,
        text: "duplicate open event",
      }),
      false
    );
    assert.equal(scans, 1);
    assert.deepEqual(published, ["file:///opening.md", "file:///opening.md"]);
    store.dispose();
  });

  if (failed > 0) {
    console.error(`\n${failed} document structure store test(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log("document structure store tests passed");
  }
}

void run();

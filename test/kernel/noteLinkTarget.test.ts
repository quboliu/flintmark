import assert from "node:assert";
import { noteLinkTarget, noteLinkCandidates } from "../../src/extension/noteLinkTarget";

assert.equal(noteLinkTarget("common/xxx.md#heading"), "common/xxx.md");
assert.equal(noteLinkTarget("../Other%20Note.markdown"), "../Other Note.markdown");
assert.equal(noteLinkTarget("folder\\Note|label"), "folder/Note");
assert.equal(noteLinkTarget("Bad%escape.md"), "Bad%escape.md");
assert.deepEqual(noteLinkCandidates("common/xxx.md"), ["common/xxx.md"]);
assert.deepEqual(noteLinkCandidates("Note.markdown"), ["Note.markdown"]);
assert.deepEqual(noteLinkCandidates("Note"), ["Note.md", "Note.markdown"]);
assert.deepEqual(noteLinkCandidates(""), []);
console.log("  ✓ note links decode once and preserve explicit note extensions");

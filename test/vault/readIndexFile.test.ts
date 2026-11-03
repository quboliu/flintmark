import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readIndexFile } from "../../src/extension/vault/readIndexFile";

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "flintmark-reader-"));
  let providerCalls = 0;
  const forbiddenProvider = async (): Promise<Uint8Array> => {
    providerCalls++;
    throw new Error("Local files must not use provider IPC");
  };
  try {
    const file = join(root, "note % space-λ.md");
    const bytes = Buffer.from("# Note\r\n\r\nUnicode: λ\r\n\0", "utf8");
    writeFileSync(file, bytes);
    const actual = await readIndexFile({scheme:"file",fsPath:file}, forbiddenProvider);
    assert.deepEqual(Buffer.from(actual), bytes);
    assert.equal(providerCalls, 0);
    console.log("  ✓ local indexing preserves exact bytes and literal filesystem paths without provider IPC");
    await assert.rejects(readIndexFile({scheme:"file",fsPath:join(root,"missing.md")}, forbiddenProvider), {code:"ENOENT"});
    assert.equal(providerCalls, 0);
    console.log("  ✓ missing local files preserve read errors without a second provider request");
    for (const scheme of ["vscode-remote", "memfs"]) {
      const uri={scheme,fsPath:file};
      const remote=Uint8Array.from([239,187,191,65,13,10]);
      const result=await readIndexFile(uri, async target=>{assert.equal(target,uri);return remote;});
      assert.equal(result,remote);
    }
    console.log("  ✓ remote and virtual files retain provider identity and bytes even when fsPath exists locally");
    const failure = new Error("Provider unavailable");
    await assert.rejects(readIndexFile({scheme:"memfs",fsPath:file}, async()=>{throw failure;}),error=>error===failure);
    console.log("  ✓ provider errors propagate unchanged");
  } finally { rmSync(root,{recursive:true,force:true}); }
}
void main().catch(error=>{console.error("  ✗ index file reader",error);process.exitCode=1;});

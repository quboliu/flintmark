import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));
const versions = {
  "package.json": packageJson.version,
  "package-lock.json": packageLock.version,
  "package-lock root package": packageLock.packages?.[""]?.version,
};
const expected = packageJson.version;
for (const [label, version] of Object.entries(versions)) {
  assert.equal(version, expected, `${label} version ${version} does not match ${expected}`);
}

console.log(`All Flintmark release manifests agree on ${expected}.`);

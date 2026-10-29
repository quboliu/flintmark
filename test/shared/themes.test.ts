import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { BUNDLED_THEMES, DEFAULT_THEME_ID, findTheme } from "../../src/extension/themes";

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

test("Catppuccin is selectable as a bundled Live Preview theme", () => {
  assert.deepEqual(findTheme("catppuccin"), {
    id: "catppuccin",
    name: "Catppuccin",
    file: "media/themes/catppuccin.css",
  });
});

test("settings offer the bundled themes with Things as the default", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const setting = manifest.contributes.configuration.properties["ofm.theme"];
  assert.deepEqual(setting.enum, ["things", "catppuccin"]);
  assert.deepEqual(BUNDLED_THEMES.map((theme) => theme.id), setting.enum);
  assert.equal(setting.default, "things");
  assert.equal(DEFAULT_THEME_ID, "things");
  assert.equal(setting.enumDescriptions.length, setting.enum.length);
  for (const theme of BUNDLED_THEMES) {
    assert.ok(existsSync(theme.file), `bundled stylesheet ${theme.file} must ship`);
  }
});

if (failed > 0) process.exit(1);

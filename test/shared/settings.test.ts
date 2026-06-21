// Pure-logic tests for shared/settings.ts — config normalization (clamp +
// sanitize) and the Settings → CSS custom-property mapping that drive the
// custom-font feature. These run host-side AND in the webview but are pure, so
// they belong at L1 (Node, no VS Code / DOM). docs/05 top-of-pyramid.
import assert from "node:assert";
import {
  normalizeSettings,
  sanitizeFontFamily,
  settingsToCssVars,
  DEFAULT_LINE_WIDTH,
  MIN_LINE_WIDTH,
  MAX_LINE_WIDTH,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
} from "../../src/shared/settings";

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

// --- normalizeSettings: lineWidth --------------------------------------------

test("lineWidth: missing → default", () => {
  assert.equal(normalizeSettings({}).lineWidth, DEFAULT_LINE_WIDTH);
});

test("lineWidth: non-number → default", () => {
  assert.equal(normalizeSettings({ lineWidth: "80" }).lineWidth, DEFAULT_LINE_WIDTH);
  assert.equal(normalizeSettings({ lineWidth: NaN }).lineWidth, DEFAULT_LINE_WIDTH);
});

test("lineWidth: in-range passes through", () => {
  assert.equal(normalizeSettings({ lineWidth: 90 }).lineWidth, 90);
});

test("lineWidth: clamps below MIN and above MAX", () => {
  assert.equal(normalizeSettings({ lineWidth: 1 }).lineWidth, MIN_LINE_WIDTH);
  assert.equal(normalizeSettings({ lineWidth: 9999 }).lineWidth, MAX_LINE_WIDTH);
});

test("lineWidth: exactly MIN and MAX pass through unchanged", () => {
  assert.equal(normalizeSettings({ lineWidth: MIN_LINE_WIDTH }).lineWidth, MIN_LINE_WIDTH);
  assert.equal(normalizeSettings({ lineWidth: MAX_LINE_WIDTH }).lineWidth, MAX_LINE_WIDTH);
});

test("lineWidth: Infinity is not finite → default", () => {
  assert.equal(normalizeSettings({ lineWidth: Infinity }).lineWidth, DEFAULT_LINE_WIDTH);
});

// --- normalizeSettings: fontFamily / monospaceFontFamily ---------------------

test("fontFamily: omitted when empty / whitespace / non-string", () => {
  assert.equal(normalizeSettings({}).fontFamily, undefined);
  assert.equal(normalizeSettings({ fontFamily: "" }).fontFamily, undefined);
  assert.equal(normalizeSettings({ fontFamily: "   " }).fontFamily, undefined);
  assert.equal(normalizeSettings({ fontFamily: 42 }).fontFamily, undefined);
});

test("font keys are ABSENT (not set to undefined) when there's no override", () => {
  const s = normalizeSettings({});
  assert.ok(!("fontFamily" in s), "fontFamily key should be absent");
  assert.ok(!("monospaceFontFamily" in s), "monospaceFontFamily key should be absent");
  assert.ok(!("fontSize" in s), "fontSize key should be absent");
});

test("fontFamily: a real font-family list is kept (trimmed)", () => {
  assert.equal(
    normalizeSettings({ fontFamily: '  "Segoe UI", sans-serif  ' }).fontFamily,
    '"Segoe UI", sans-serif'
  );
});

test("monospaceFontFamily: kept independently of fontFamily", () => {
  const s = normalizeSettings({ monospaceFontFamily: "'JetBrains Mono', monospace" });
  assert.equal(s.fontFamily, undefined);
  assert.equal(s.monospaceFontFamily, "'JetBrains Mono', monospace");
});

// --- normalizeSettings: fontSize ---------------------------------------------

test("fontSize: 0 / negative / below MIN → omitted (no override)", () => {
  assert.equal(normalizeSettings({ fontSize: 0 }).fontSize, undefined);
  assert.equal(normalizeSettings({ fontSize: -5 }).fontSize, undefined);
  assert.equal(normalizeSettings({ fontSize: MIN_FONT_SIZE - 1 }).fontSize, undefined);
});

test("fontSize: at/above MIN takes effect, clamped to MAX", () => {
  assert.equal(normalizeSettings({ fontSize: MIN_FONT_SIZE }).fontSize, MIN_FONT_SIZE);
  assert.equal(normalizeSettings({ fontSize: 18 }).fontSize, 18);
  assert.equal(normalizeSettings({ fontSize: 9999 }).fontSize, MAX_FONT_SIZE);
});

test("fontSize: non-number / NaN / Infinity → omitted", () => {
  assert.equal(normalizeSettings({ fontSize: "16" }).fontSize, undefined);
  assert.equal(normalizeSettings({ fontSize: NaN }).fontSize, undefined);
  assert.equal(normalizeSettings({ fontSize: Infinity }).fontSize, undefined);
});

test("fontSize: exactly MAX passes; above MAX clamps to MAX", () => {
  assert.equal(normalizeSettings({ fontSize: MAX_FONT_SIZE }).fontSize, MAX_FONT_SIZE);
  assert.equal(normalizeSettings({ fontSize: MAX_FONT_SIZE + 10 }).fontSize, MAX_FONT_SIZE);
});

// --- sanitizeFontFamily ------------------------------------------------------

test("sanitize: non-string → undefined", () => {
  assert.equal(sanitizeFontFamily(undefined), undefined);
  assert.equal(sanitizeFontFamily(123), undefined);
  assert.equal(sanitizeFontFamily(null), undefined);
});

test("sanitize: keeps CJK font names, quotes, commas, spaces, hyphens", () => {
  assert.equal(sanitizeFontFamily("霞鹜文楷, 'Maple Mono'"), "霞鹜文楷, 'Maple Mono'");
  assert.equal(sanitizeFontFamily("LXGW WenKai-Regular"), "LXGW WenKai-Regular");
});

test("sanitize: strips CSS-injection / markup characters", () => {
  // The dangerous chars are removed; the surviving text is the font name only.
  assert.equal(
    sanitizeFontFamily('Evil; } body { display:none } "X'),
    'Evil  body  display:none  "X'
  );
  assert.equal(sanitizeFontFamily("a<script>b"), "ascriptb");
});

test("sanitize: strips control characters but keeps ordinary spaces", () => {
  assert.equal(sanitizeFontFamily("A" + String.fromCharCode(0x00) + "B" + String.fromCharCode(0x1f) + "C" + String.fromCharCode(0x7f) + "D"), "ABCD");
  assert.equal(sanitizeFontFamily("My Font"), "My Font");
});

test("sanitize: all-stripped or whitespace-only → undefined", () => {
  assert.equal(sanitizeFontFamily(";;;{}"), undefined);
  assert.equal(sanitizeFontFamily("   "), undefined);
});

// --- settingsToCssVars -------------------------------------------------------

test("cssVars: returns the four override vars in a stable order", () => {
  const names = settingsToCssVars({}).map((v) => v.name);
  assert.deepEqual(names, [
    "--file-line-width",
    "--ofm-font-family",
    "--ofm-font-monospace",
    "--ofm-font-size",
  ]);
});

function valueOf(vars: { name: string; value: string | null }[], name: string): string | null {
  const v = vars.find((x) => x.name === name);
  assert.ok(v, `expected a var named ${name}`);
  return v!.value;
}

test("cssVars: lineWidth → rem; missing/0 → null", () => {
  assert.equal(valueOf(settingsToCssVars({ lineWidth: 75 }), "--file-line-width"), "75rem");
  assert.equal(valueOf(settingsToCssVars({ lineWidth: 0 }), "--file-line-width"), null);
  assert.equal(valueOf(settingsToCssVars({}), "--file-line-width"), null);
});

test("cssVars: fontFamily present → set; absent → null (removes → reverts)", () => {
  assert.equal(
    valueOf(settingsToCssVars({ fontFamily: '"Iosevka"' }), "--ofm-font-family"),
    '"Iosevka"'
  );
  assert.equal(valueOf(settingsToCssVars({}), "--ofm-font-family"), null);
});

test("cssVars: monospaceFontFamily present → set; absent → null", () => {
  assert.equal(
    valueOf(settingsToCssVars({ monospaceFontFamily: "monospace" }), "--ofm-font-monospace"),
    "monospace"
  );
  assert.equal(valueOf(settingsToCssVars({}), "--ofm-font-monospace"), null);
});

test("cssVars: fontSize → px; absent/0/negative → null", () => {
  assert.equal(valueOf(settingsToCssVars({ fontSize: 16 }), "--ofm-font-size"), "16px");
  assert.equal(valueOf(settingsToCssVars({ fontSize: 0 }), "--ofm-font-size"), null);
  assert.equal(valueOf(settingsToCssVars({ fontSize: -5 }), "--ofm-font-size"), null);
  assert.equal(valueOf(settingsToCssVars({}), "--ofm-font-size"), null);
});

test("cssVars: lineWidth 0 / negative → null (not '0rem')", () => {
  assert.equal(valueOf(settingsToCssVars({ lineWidth: -1 }), "--file-line-width"), null);
});

test("cssVars: a full settings object round-trips end to end", () => {
  const vars = settingsToCssVars(
    normalizeSettings({
      lineWidth: 80,
      fontFamily: '"LXGW WenKai", sans-serif',
      fontSize: 18,
      monospaceFontFamily: '"Maple Mono", monospace',
    })
  );
  assert.equal(valueOf(vars, "--file-line-width"), "80rem");
  assert.equal(valueOf(vars, "--ofm-font-family"), '"LXGW WenKai", sans-serif');
  assert.equal(valueOf(vars, "--ofm-font-monospace"), '"Maple Mono", monospace');
  assert.equal(valueOf(vars, "--ofm-font-size"), "18px");
});

if (failed > 0) {
  console.error(`\n${failed} settings test(s) FAILED`);
  process.exit(1);
}
console.log("\nAll settings tests passed");

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

// Exercise browser-computed sizes using the shipped theme and heading rules.
const theme = readFileSync("media/themes/things.css", "utf8");
const source = readFileSync("src/webview/view/markdownTheme.ts", "utf8");
const rules = [...source.matchAll(/"\.cm-line\.ofm-heading-(\d)": \{\s*fontSize: "([^"]+)"/g)];
assert.equal(rules.length, 6);
const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
  const page = await browser.newPage();
  await page.setContent('<style>' + theme + '\n' +
    rules.map(([, n, size]) => '.ofm-heading-' + n + '{font-size:' + size + '}').join('\n') +
    '</style><div id="editor"><div class="cm-content">' +
    rules.map(([, n]) => '<div class="cm-line ofm-heading-' + n + '">Heading</div>').join('') +
    '</div></div>');
  const measure = async (size) => page.evaluate((size) => {
    document.querySelector(".cm-content").style.fontSize = size + "px";
    return [...document.querySelectorAll(".cm-line")].map(el => parseFloat(getComputedStyle(el).fontSize));
  }, size);
  const small = await measure(16);
  const large = await measure(32);
  console.log(JSON.stringify({ bodySizes: [16, 32], small, large }));
  for (let i = 0; i < 6; i++) {
    assert.ok(Math.abs(large[i] - small[i] * 2) < 0.01, 'H' + (i + 1) + ' should scale with prose');
    assert.ok(small[i] >= 16 && large[i] >= 32, 'H' + (i + 1) + ' should be at least body size');
  }
} finally {
  await browser.close();
}

export async function palette(win, combo, text, options = {}) {
  const waitBeforeEnter = options.waitBeforeEnter ?? 1200;
  const waitAfterEnter = options.waitAfterEnter ?? 1500;
  const widget = win.locator(".quick-input-widget");
  const input = widget.locator("input").first();
  const openers = combo === "Control+Shift+P" ? [combo, "F1"] : [combo];
  let lastError = null;

  for (let attempt = 0; attempt < 6; attempt++) {
    await win.bringToFront().catch(() => {});
    await win
      .locator(".tab.active")
      .first()
      .click({ position: { x: 14, y: 12 }, timeout: 1000 })
      .catch(() => {});
    await win.keyboard.press("Escape").catch(() => {});
    await win.waitForTimeout(150);
    await win.keyboard.press(openers[attempt % openers.length]);

    try {
      await widget.waitFor({ state: "visible", timeout: 3000 });
      await input.waitFor({ state: "visible", timeout: 2000 });
      await input.fill(text);
      await win.waitForTimeout(waitBeforeEnter);
      const matchingRow = widget.locator(".monaco-list-row").filter({ hasText: text }).first();
      if (await matchingRow.isVisible().catch(() => false)) {
        await matchingRow.click();
      } else {
        await win.keyboard.press("Enter");
      }
      await win.waitForTimeout(waitAfterEnter);
      return;
    } catch (e) {
      lastError = e;
    }
  }

  throw lastError;
}

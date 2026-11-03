export async function palette(win, combo, text, options = {}) {
  const waitBeforeEnter = options.waitBeforeEnter ?? 1200;
  const waitAfterEnter = options.waitAfterEnter ?? 1500;
  const commandMode = /Shift\+P$/i.test(combo) || combo === 'F1';
  if (process.platform === 'darwin') combo = combo.replace(/^Control\+/, 'Meta+');
  if (commandMode && !text.startsWith('>')) text = '>' + text;
  const widget = win.locator('.quick-input-widget');
  const input = widget.locator('input:not([type=checkbox])').first();
  const openers = /^(Control|Meta)\+Shift\+P$/.test(combo) ? [combo, 'F1'] : [combo];
  const normalized = text.replace(/\\/g, '/');
  const basename = normalized.split('/').at(-1);
  const directory = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')).replace(/^\.\//, '') : '';
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    await win.bringToFront().catch(() => {});
    if (!options.preserveEditorFocus) await win.locator('.tab.active').first().click({position:{x:14,y:12},timeout:1000}).catch(() => {});
    await win.keyboard.press('Escape').catch(() => {});
    await win.waitForTimeout(150);
    await win.keyboard.press(openers[attempt % openers.length]);
    try {
      await widget.waitFor({state:'visible',timeout:3000});
      await input.waitFor({state:'visible',timeout:2000});
      await input.fill(text);
      await win.waitForTimeout(waitBeforeEnter);
      const rows = widget.locator('.monaco-list-row');
      const deadline = Date.now() + 10000;
      let candidates = [], selected = null, previous = '';
      while (Date.now() < deadline) {
        if (await input.inputValue() !== text) throw Error('Quick Input query changed unexpectedly');
        candidates = await rows.evaluateAll(elements => elements.map((element,index) => ({
          index,
          text:element.innerText,
          name:element.querySelector('.label-name')?.textContent?.trim() ?? '',
          description:element.querySelector('.label-description')?.textContent?.trim() ?? '',
          title:element.getAttribute('title') ?? '',
          aria:element.getAttribute('aria-label') ?? '',
          visible:!!element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden',
        })));
        const exactCommands = commandMode ? candidates.filter(row => row.visible && row.name === text.slice(1)) : [];
        // Cursor names the global command Close All Tabs. Never substitute the
        // narrower Close All Editors in Group command for a global close.
        const closeAll = commandMode && text.slice(1) === 'View: Close All Editors';
        const aliases = closeAll ? candidates.filter(row => row.visible && row.name === 'View: Close All Tabs') : [];
        const matches = exactCommands.length ? exactCommands : aliases.length ? aliases : candidates.filter(row => {
          if (!row.visible) return false;
          if (commandMode) return !closeAll && row.text.replace(/\s+/g,' ').includes(text.slice(1));
          if (row.name !== basename) return false;
          const folder = row.description.replace(/\\/g,'/').replace(/^\.\//,'').replace(/\/$/,'');
          return !directory || folder === directory || folder.endsWith('/'+directory);
        });
        const key = JSON.stringify(matches);
        if (matches.length === 1 && key === previous) { selected = matches[0]; break; }
        previous = key;
        await win.waitForTimeout(150);
      }
      if (!selected) throw Error('Quick Input requires one stable matching result: '+JSON.stringify({query:text,candidates}));
      if (await input.inputValue() !== text || await rows.nth(selected.index).innerText() !== selected.text) throw Error('Quick Input changed before selection');
      await rows.nth(selected.index).click();
      if (!commandMode) await widget.waitFor({state:'hidden',timeout:10000});
      console.log('QUICK_INPUT_SELECTED',JSON.stringify({query:text,commandMode,selected,candidates}));
      await win.waitForTimeout(waitAfterEnter);
      return;
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

// Select the contributed editor by its exact current display name. Typing the
// legacy name into this picker produces no matches and leaves it open.
export async function reopenLivePreview(win) {
  await palette(win, 'Control+Shift+P', 'View: Reopen Editor With...');
  const widget = win.locator('.quick-input-widget');
  await widget.waitFor({state:'visible',timeout:10000});
  const input = widget.locator('input:not([type=checkbox])').first();
  await input.fill('Flintmark Live Preview');
  const choice = widget.locator('.monaco-list-row').filter({
    has: win.locator('.label-name', {hasText:/^Flintmark Live Preview$/}),
  });
  await choice.waitFor({state:'visible',timeout:10000});
  await choice.click();
  await widget.waitFor({state:'hidden',timeout:10000});
}

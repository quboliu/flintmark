// Dismiss only the editor's known first-run welcome overlay using its Close button.
// Keep the handler short: screenshots inside it can exhaust the triggering
// action's timeout before the overlay has been dismissed.
const fs = require('node:fs');
const path = require('node:path');
exports.registerEditorOnboarding = async (app, out) => {
  const win = await app.firstWindow();
  const overlay = win.locator('.onboarding-a-overlay[role="dialog"][aria-label="Welcome to Visual Studio Code"]');
  await win.addLocatorHandler(overlay, async () => {
    await overlay.locator('button.onboarding-a-close-btn').click({timeout:10000});
    const record = {event:'dismissed-with-native-close-button',platform:process.platform};
    console.log('EDITOR_ONBOARDING', JSON.stringify(record));
    if (out) {
      fs.mkdirSync(out,{recursive:true});
      fs.appendFileSync(path.join(out,'editor-onboarding.jsonl'),JSON.stringify(record)+'\n');
    }
  }, {times:1});
};

// Real webview + native save commands. Deterministic delayed-transport cases
// are covered by integration/save.test.ts; this suite checks actual UI wiring.
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { palette } from './quickInput.mjs';
import { adaptWindow } from '../acceptance/native-window.mjs';
const work=fs.mkdtempSync(path.join(os.tmpdir(),'flintmark-save-ui-'));
const output=process.env.FLINTMARK_OUT || path.resolve('out/save-barrier');
fs.mkdirSync(output,{recursive:true});
const profile=path.join(work,'profile');fs.mkdirSync(path.join(profile,'User'),{recursive:true});
fs.writeFileSync(path.join(profile,'User/settings.json'),JSON.stringify({
 'workbench.editorAssociations':{'*.md':'ofm.livePreview'},
 'security.workspace.trust.enabled':false,'workbench.startupEditor':'none',
 'telemetry.telemetryLevel':'off','update.mode':'none','files.autoSave':'off',
}));
const app=await electron.launch({executablePath:process.env.VSCODE_BIN || '/usr/share/codium/codium',args:[
 '--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--skip-welcome','--skip-release-notes',
 '--user-data-dir='+profile,'--extensions-dir='+path.join(work,'extensions'),
 '--extensionDevelopmentPath='+process.cwd(),work,
]});
const records=[],errors=[];let win;
const mod=process.platform==='darwin'?'Meta':'Control';
async function until(fn,label){for(let i=0;i<150;i++){if(await fn())return;await win.waitForTimeout(100);}throw Error(label);}
async function nativeSave(all) {
 await win.keyboard.press('F1');
 const widget=win.locator('.quick-input-widget');
 await widget.locator('input:not([type=checkbox])').first().fill('>File: Save');
 const command=all?'workbench.action.files.saveFiles':'workbench.action.files.save';
 const row=widget.locator('[data-quick-input-id="'+command+'"]');
 await row.waitFor({state:'visible'});
 await win.mouse.move(5,5); // Keep hover documentation away from the target row.
 await row.click({position:{x:12,y:10}});
 await widget.waitFor({state:'hidden'});
}
async function content(frame){return frame.evaluate(()=>document.querySelector('.cm-content').cmTile.root.view.state.doc.toString());}
try {
 win=await adaptWindow(await app.firstWindow(),app);
 win.on('pageerror',error=>errors.push(String(error)));
 await win.waitForSelector('.monaco-workbench');
 for(const eol of ['LF','CRLF']) for(const entry of ['content','search','native','save-all','undo-redo']){
  const marker=eol+' '+entry, file=path.join(work,eol+'-'+entry+'.md');
  const initial='# '+marker+'\n\n'+('Background paragraph. '.repeat(35)+'\n').repeat(8);
  fs.writeFileSync(file,eol==='CRLF'?initial.replace(/\n/g,'\r\n'):initial);
  await palette(win,mod+'+p',path.basename(file));
  let frame;
  await until(async()=>{for(const f of win.frames())try{if((await content(f)).startsWith('# '+marker+'\n')&&await f.locator('.cm-content').isVisible()){frame=f;return true;}}catch{}return false;},'Live Preview missing');
  if(entry==='search'){
   await frame.locator('.cm-content').click();await win.keyboard.press(mod+'+f');
   await frame.locator('.cm-search input').first().waitFor({state:'visible'});
  }
  const addition=Array.from({length:4},(_,i)=>'\n*Answer:* '+i+' '+('Complete answer paragraph. '.repeat(20))+'\n\nSecond paragraph.\n').join('');
  // A burst plus a save in one browser task exercises request ordering before
  // the extension host can acknowledge the first chunk.
  await frame.evaluate(({addition,entry,mac})=>{
   const view=document.querySelector('.cm-content').cmTile.root.view;
   for(const chunk of addition.match(/.{1,31}|\n/g)) view.dispatch({changes:{from:view.state.doc.length,insert:chunk}});
   const target=entry==='search'?document.querySelector('.cm-search input'):view.contentDOM;
   target.focus();
   if(entry==='content'||entry==='search'){
    const event=new KeyboardEvent('keydown',{key:'s',code:'KeyS',ctrlKey:!mac,metaKey:mac,bubbles:true,cancelable:true});
    target.dispatchEvent(event);
    if(!event.defaultPrevented)throw Error('Save shortcut was not handled');
   }
  },{addition,entry,mac:process.platform==='darwin'});
  let expected=initial+addition;
  if(entry==='native') await nativeSave(false);
  if(entry==='save-all') await nativeSave(true);
  if(entry==='undo-redo'){
   // Native undo/redo must remain ordered after a burst of optimistic edits.
   await frame.locator('.cm-content').click();
   await win.keyboard.press(mod+'+z');
   await until(async()=>await content(frame)!==expected,'Undo had no effect');
   const afterUndo=await content(frame);
   await win.keyboard.press(process.platform==='darwin'?'Meta+Shift+Z':'Control+y');
   try { await until(async()=>await content(frame)===expected,'Redo failed to restore exact text'); } catch(error) { fs.writeFileSync(path.join(output,'redo-diagnostic.json'),JSON.stringify({expected,afterUndo,actual:await content(frame)},null,2)); throw error; }
   await win.keyboard.press(mod+'+s');
  }
  const expectedDisk=eol==='CRLF'?expected.replace(/\n/g,'\r\n'):expected;
  await until(()=>fs.readFileSync(file,'utf8')===expectedDisk,'Save wrote stale/incomplete text: '+marker);
  assert.equal(await content(frame),expected);
  fs.copyFileSync(file,path.join(output,path.basename(file)));
  records.push({eol,entry,bytes:Buffer.byteLength(expectedDisk),passed:true});
  console.log('SAVE_BARRIER_CASE',JSON.stringify(records.at(-1)));
  await palette(win,mod+'+Shift+p','View: Close All Editors');
 }
 assert.deepEqual(errors,[]);assert.equal(records.length,10);
} finally {
 fs.writeFileSync(path.join(output,'save-barrier.json'),JSON.stringify({records,errors,passed:records.length===10&&errors.length===0},null,2));
 await app.close();
}

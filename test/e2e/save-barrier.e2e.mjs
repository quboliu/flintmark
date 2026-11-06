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
 ...(/cursor/i.test(process.env.VSCODE_BIN || '') ? ['--skip-onboarding'] : []),
 '--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--skip-welcome','--skip-release-notes',
 '--user-data-dir='+profile,'--extensions-dir='+path.join(work,'extensions'),
 '--extensionDevelopmentPath='+process.cwd(),work,
]});
const records=[],errors=[],hostDiagnostics=[];let win;let activeCase='startup';
const mod=process.platform==='darwin'?'Meta':'Control';
async function until(fn,label){for(let i=0;i<150;i++){if(await fn())return;await win.waitForTimeout(100);}throw Error(label);}
async function nativeSave(all) {
 await win.keyboard.press('F1');
 const widget=win.locator('.quick-input-widget');
 await widget.locator('input:not([type=checkbox])').first().fill('>File: Save');
 // Older VS Code-family hosts do not expose data-quick-input-id. Match the
 // complete command label, excluding Save As / Save All in Group.
 const label=all?/^File: Save All(?: Files)?$/:/^File: Save$/;
 const row=widget.locator('.monaco-list-row').filter({has:win.locator('.label-name').filter({hasText:label})});
 await row.waitFor({state:'visible'});
 assert.equal(await row.count(),1,'Native save command must be unambiguous');
 await win.mouse.move(5,5); // Keep hover documentation away from the target row.
 await row.click({position:{x:12,y:10}});
 await widget.waitFor({state:'hidden'});
}
async function content(frame){return frame.evaluate(()=>document.querySelector('.cm-content').cmTile.root.view.state.doc.toString());}
try {
 win=await adaptWindow(await app.firstWindow(),app);
 win.on('pageerror',error=>{
  const detail=String(error.stack||error);
  // Reproduced in a fresh Cursor profile with no Flintmark extension: its
  // advanced diff worker asserts on CRLF edits. Keep the complete evidence,
  // but distinguish this exact host defect from extension/runtime failures.
  const knownHostDiff=/cursor/i.test(process.env.VSCODE_BIN||'') && activeCase.startsWith('CRLF/') &&
   detail.startsWith('Error: Assertion Failed') && detail.includes('editorWebWorkerMain.js#TextEditorWorker') &&
   detail.includes('lineRangeMappingFromRangeMappings') && detail.includes('DefaultLinesDiffComputer.computeDiff');
  if(knownHostDiff)hostDiagnostics.push({activeCase,detail});else errors.push(detail);
  console.log(knownHostDiff?'SAVE_HOST_DIAGNOSTIC':'SAVE_PAGE_ERROR',JSON.stringify({activeCase,detail}));
 });
 await win.waitForSelector('.monaco-workbench');
 for(const eol of ['LF','CRLF']) for(const entry of ['content','search','native','save-all','undo-redo']){
  activeCase=eol+'/'+entry;
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
  // Burst optimistic input, then press the real editor shortcut immediately.
  // The integration suite deterministically gates transport and host applies.
  await frame.evaluate(({addition,entry})=>{
   const view=document.querySelector('.cm-content').cmTile.root.view;
   for(const chunk of addition.match(/.{1,31}|\n/g)) view.dispatch({changes:{from:view.state.doc.length,insert:chunk}});
   const target=entry==='search'?document.querySelector('.cm-search input'):view.contentDOM;
   target.focus();
  },{addition,entry});
  if(entry==='content'||entry==='search') await win.keyboard.press(mod+'+s');
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
} catch(error) {
 fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({error:String(error.stack||error),records},null,2));
 if(win) await win.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
 throw error;
} finally {
 fs.writeFileSync(path.join(output,'save-barrier.json'),JSON.stringify({records,errors,hostDiagnostics,passed:records.length===10&&errors.length===0},null,2));
 await app.close();
}

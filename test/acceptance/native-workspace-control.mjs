// Diagnostic control: same workspace and external writer, without Flintmark.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {fork,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const require=createRequire(path.join(process.env.FLINTMARK_DEPS,'package.json'));
const { _electron:electron }=require('playwright');
const out=process.env.FLINTMARK_OUT,work=process.env.FLINTMARK_NATIVE_CONTROL_WORK;
const webviewControl=process.env.FLINTMARK_NATIVE_CONTROL_MODE==='webview';
fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fm-native-control-'));
fs.mkdirSync(path.join(profile,'User'));
fs.writeFileSync(path.join(profile,'User/settings.json'),JSON.stringify({'workbench.startupEditor':'none','security.workspace.trust.enabled':false,'workbench.editorAssociations':{'*.md':webviewControl?'control.webview':'default'},'chat.disableAIFeatures':true,'update.mode':'none','telemetry.telemetryLevel':'off'}));
if(webviewControl){
 const helper=path.join(profile,'extensions','local-test.webview-control-1.0.0');fs.mkdirSync(helper,{recursive:true});
 fs.writeFileSync(path.join(helper,'package.json'),JSON.stringify({name:'webview-control',publisher:'local-test',version:'1.0.0',engines:{vscode:'^1.89.0'},activationEvents:['*'],main:'main.js',contributes:{customEditors:[{viewType:'control.webview',displayName:'Minimal Webview Control',selector:[{filenamePattern:'*.md'}],priority:'default'}]}}));
 fs.writeFileSync(path.join(helper,'main.js'),"const vscode=require('vscode');exports.activate=ctx=>ctx.subscriptions.push(vscode.window.registerCustomEditorProvider('control.webview',{resolveCustomTextEditor(doc,panel){panel.webview.html='<html><body><div id=control contenteditable=true style=\"white-space:pre-wrap;min-height:200px;font:16px monospace\">'+doc.getText().replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</div></body></html>';}}));");
 const helperEntry=path.join(helper,'main.js');
 let helperSource=fs.readFileSync(helperEntry,'utf8').replace('exports.activate=ctx=>ctx.subscriptions.push','exports.activate=async ctx=>{ctx.subscriptions.push');
 helperSource+="await vscode.commands.executeCommand('vscode.openWith',vscode.Uri.file("+JSON.stringify(path.join(work,'open.md'))+"),'control.webview');};";
 fs.writeFileSync(helperEntry,helperSource);
}
const writer=fork(fileURLToPath(new URL('./writer-child.mjs',import.meta.url)),[],{execArgv:[],env:{...process.env,FLINTMARK_NOISE_FIXTURE:work,FLINTMARK_NOISE_PREFIX:'native-control-'+process.pid+'-',FLINTMARK_NOISE_INTERVAL_MS:'25'},stdio:['ignore','ignore','pipe','ipc']});
const messages=[];writer.on('message',m=>messages.push(m));
let app;const result={control:true,flintmarkInstalled:false,mode:webviewControl?'webview':'source',passed:false,started:performance.now()};
try{
 app=await electron.launch({executablePath:process.env.VSCODE_BIN,args:['--no-sandbox','--disable-gpu','--skip-welcome','--skip-onboarding',...(webviewControl?[]:['--disable-extensions']),'--user-data-dir='+profile,'--extensions-dir='+path.join(profile,'extensions'),work,path.join(work,'open.md')],timeout:120000});
 const win=await app.firstWindow();await win.waitForSelector('.monaco-workbench',{timeout:60000});
 let lines=win.locator('.monaco-editor .view-lines').first();
 if(webviewControl){const deadline=Date.now()+60000;let found=false;while(Date.now()<deadline&&!found){for(const frame of win.frames()){const candidate=frame.locator('#control');if(await candidate.count()){lines=candidate;found=true;break;}}if(!found)await win.waitForTimeout(100);}if(!found)throw Error('Minimal custom webview did not load');}
 await lines.waitFor({state:'visible',timeout:60000});
 await lines.click({timeout:30000});await win.keyboard.press(process.platform==='darwin'?'Meta+ArrowDown':'Control+End');await win.keyboard.insertText('NATIVE_CONTROL');
 await win.waitForTimeout(1000);result.text=await lines.innerText({timeout:10000});
 if(!result.text.includes('NATIVE_CONTROL'))throw Error('Native editor did not receive input');
 await win.screenshot({path:path.join(out,'native-control.png'),timeout:5000});result.passed=true;
}catch(error){result.error=String(error.stack||error);
 if(app?.process()?.pid&&process.platform==='darwin'){
  const ps=spawnSync('ps',['-axo','pid=,ppid=,%cpu=,rss=,comm='],{encoding:'utf8',timeout:3000});fs.writeFileSync(path.join(out,'processes.txt'),ps.stdout||String(ps.error));
  const sample=spawnSync('sample',[String(app.process().pid),'1','-file',path.join(out,'main-sample.txt')],{encoding:'utf8',timeout:15000});fs.writeFileSync(path.join(out,'sample-command.json'),JSON.stringify({status:sample.status,error:sample.error?.message,stdout:sample.stdout,stderr:sample.stderr}));
 }
}finally{
 try{writer.send({type:'stop'});}catch{}
 await new Promise(resolve=>setTimeout(resolve,1000));if(writer.exitCode===null)writer.kill();
 if(app){const child=app.process();await Promise.race([app.close().catch(()=>{}),new Promise(r=>setTimeout(r,5000))]);if(child?.exitCode===null)child.kill('SIGKILL');}
 result.durationMs=performance.now()-result.started;result.writer=messages.at(-1);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
process.exit(result.passed?0:1);

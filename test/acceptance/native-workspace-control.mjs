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
fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'fm-native-control-'));
fs.mkdirSync(path.join(profile,'User'));
fs.writeFileSync(path.join(profile,'User/settings.json'),JSON.stringify({'workbench.startupEditor':'none','security.workspace.trust.enabled':false,'workbench.editorAssociations':{'*.md':'default'},'chat.disableAIFeatures':true,'update.mode':'none','telemetry.telemetryLevel':'off'}));
const writer=fork(fileURLToPath(new URL('./writer-child.mjs',import.meta.url)),[],{execArgv:[],env:{...process.env,FLINTMARK_NOISE_FIXTURE:work,FLINTMARK_NOISE_PREFIX:'native-control-'+process.pid+'-',FLINTMARK_NOISE_INTERVAL_MS:'25'},stdio:['ignore','ignore','pipe','ipc']});
const messages=[];writer.on('message',m=>messages.push(m));
let app;const result={control:true,pluginInstalled:false,passed:false,started:performance.now()};
try{
 app=await electron.launch({executablePath:process.env.VSCODE_BIN,args:['--no-sandbox','--disable-gpu','--skip-welcome','--skip-onboarding','--disable-extensions','--user-data-dir='+profile,'--extensions-dir='+path.join(profile,'extensions'),work,path.join(work,'open.md')],timeout:120000});
 const win=await app.firstWindow();await win.waitForSelector('.monaco-workbench',{timeout:60000});
 const lines=win.locator('.monaco-editor .view-lines').first();await lines.waitFor({state:'visible',timeout:60000});
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

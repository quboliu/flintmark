import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const repo=process.cwd(),harness=path.join(repo,'test/acceptance');
const read=p=>JSON.parse(fs.readFileSync(p)),hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const candidateFile=path.resolve(process.env.FLINTMARK_CANDIDATE_MANIFEST||'candidate/manifest.json');
const candidate=read(candidateFile),vsix=path.join(path.dirname(candidateFile),candidate.vsix);
assert.equal(hash(vsix),candidate.vsixSha256);
assert.equal(candidate.sourceCommit,execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),'Candidate and tests must use the same source');
assert(process.env.VSCODE_BIN,'VSCODE_BIN is required');
const editor=process.env.FLINTMARK_EDITOR;assert(['vscode','vscodium','cursor'].includes(editor));
const root=path.resolve('out/acceptance',editor);fs.mkdirSync(root,{recursive:true});
const summaryFile=path.join(root,'summary.json');assert(!fs.existsSync(summaryFile),'Preserve earlier evidence');
const corpus=path.resolve('out/acceptance-corpus');
const common={...process.env,FLINTMARK_REPO:repo,FLINTMARK_DEPS:repo,FLINTMARK_READY_GATE:'1',FLINTMARK_READY_HELPERS:harness,FLINTMARK_VSIX:vsix,FLINTMARK_CANDIDATE_MANIFEST:candidateFile,FLINTMARK_CORPUS:corpus,FLINTMARK_STRESS_FILES:'20000',FLINTMARK_STRESS_IMAGES:'4200',FLINTMARK_STRESS_NOISE:'1'};
// PowerShell 7's module path is incompatible with nested Windows PowerShell 5.
if(process.platform==='win32')for(const key of Object.keys(common))if(key.toLowerCase()==='psmodulepath')delete common[key];
execFileSync(process.execPath,[path.join(harness,'generate-corpus.mjs')],{env:common,stdio:'inherit'});
const stages=[
 ['integration','out/test/runTest.js',false,600000],
 ['save-barrier','test/e2e/save-barrier.e2e.mjs',true,600000],
 ['native-scroll','test/e2e/native-scroll-anchor.e2e.mjs',false,600000],
 ['observer-controls','test/e2e/wheel-observer.e2e.mjs',false,300000],
 ...['livepreview-viewport-clock','todo-strict','external-update-command-map','theme-mode','image-index-lifecycle','issue-regressions','panel-sync-preserve-focus','crlf-boundaries'].map(n=>[n,`test/acceptance/${n}.e2e.mjs`,true,900000]),
 ['corpus','test/acceptance/corpus-session.mjs',true,3600000],
 ['workspace','test/acceptance/workspace-registered.mjs',true,1800000],
];
let desktop;
if(process.platform==='win32'){
 const script="Add-Type -AssemblyName System.Windows.Forms;[pscustomobject]@{sessionId=(Get-Process -Id $PID).SessionId;interactive=[Environment]::UserInteractive;width=[System.Windows.Forms.SystemInformation]::VirtualScreen.Width;height=[System.Windows.Forms.SystemInformation]::VirtualScreen.Height}|ConvertTo-Json -Compress";
 desktop=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:common,encoding:'utf8',timeout:30000}).trim());
 fs.writeFileSync(path.join(root,'desktop.json'),JSON.stringify(desktop,null,2)+'\n');
 assert(desktop.sessionId>0&&desktop.interactive&&desktop.width>0&&desktop.height>0,'Windows GUI acceptance requires an interactive desktop, not service session zero');
}
const report={desktop,sourceCommit:candidate.sourceCommit,vsixSha256:candidate.vsixSha256,version:candidate.version,platform:process.platform,arch:process.arch,editor,stages:[],passed:false};
const save=()=>fs.writeFileSync(summaryFile,JSON.stringify(report,null,2)+'\n');save();
try{
 for(const [name,script,installed,timeout]of stages){
  const out=path.join(root,name==='workspace'?'workspace-stress':name);fs.mkdirSync(out,{recursive:true});const log=path.join(out,'runner.log'),fd=fs.openSync(log,'wx');
  const env={...common,FLINTMARK_OUT:out,FLINTMARK_TRIAGE_OUT:path.join(out,'diagnostics'),FLINTMARK_ANCHOR_RESULTS:path.join(out,'results'),FLINTMARK_OBSERVER_RESULTS:path.join(out,'results')};
  const args=[...(installed?['--require',path.join(harness,'readiness.cjs'),'--require',path.join(harness,'installed-candidate.cjs')]:[]),path.resolve(script)];
  const started=performance.now();console.log(`Starting ${editor}/${name}`);
  const result=spawnSync(process.execPath,args,{cwd:repo,env,stdio:['ignore',fd,fd],timeout,killSignal:'SIGKILL'});fs.closeSync(fd);
  report.stages.push({name,exitCode:result.status,signal:result.signal,error:result.error?.message,durationMs:performance.now()-started,installed});save();
  const text=fs.readFileSync(log,'utf8');process.stdout.write(text.slice(-16000));
  if(result.status!==0&&name==='workspace'&&process.platform==='darwin'&&editor==='cursor'){
   const failure=read(path.join(out,'workspace-stress.json'));
   for(const mode of ['source','webview']){
   const controlOut=path.join(out,'native-control',mode);fs.mkdirSync(controlOut,{recursive:true});
   const controlFd=fs.openSync(path.join(controlOut,'runner.log'),'wx');
   spawnSync(process.execPath,[path.join(harness,'native-workspace-control.mjs')],{cwd:repo,env:{...common,FLINTMARK_OUT:controlOut,FLINTMARK_NATIVE_CONTROL_WORK:failure.work,FLINTMARK_NATIVE_CONTROL_MODE:mode},stdio:['ignore',controlFd,controlFd],timeout:240000,killSignal:'SIGKILL'});fs.closeSync(controlFd);
   }
  }
  assert.equal(result.status,0,`${editor}/${name} failed; inspect the full runner.log`);
  if(installed)assert.equal(read(path.join(out,'installed-candidate.json')).vsixSha256,candidate.vsixSha256);
  if(name==='save-barrier'){const r=read(path.join(out,'save-barrier.json'));assert(r.passed);assert.deepEqual(r.records.map(x=>x.eol+'/'+x.entry),['LF','CRLF'].flatMap(eol=>['content','search','native','save-all','undo-redo'].map(entry=>eol+'/'+entry)));assert(r.records.every(x=>x.passed));assert.deepEqual(r.errors,[]);report.saveBarrier={cases:r.records.length,hostDiagnostics:r.hostDiagnostics??[]};if(r.hostDiagnostics?.length)console.warn("Known Cursor CRLF diff-worker diagnostics (also reproduced without Flintmark):",r.hostDiagnostics.length);}
  if(name==='native-scroll'||name==='observer-controls'){
   const r=read(path.join(out,'results/results.json'));assert.equal(r.results.length,name==='native-scroll'?93:6);assert(r.results.every(x=>x.pass));assert.deepEqual(r.pageErrors,[]);
  }
  if(name==='livepreview-viewport-clock'){
   const records=text.split('\n').filter(x=>x.startsWith('VISIBLE_WHEEL_DISPLACEMENT '));assert.equal(records.length,1);
   const r=JSON.parse(records[0].slice('VISIBLE_WHEEL_DISPLACEMENT '.length));assert.equal(r.gestures,200);assert(r.matchedPositions>=180);assert(r.maxErrorPx<=1);assert(r.maxBrowserProgressMs<=500);report.visibleWheel=r;
  }
  if(name==='corpus'){
   const r=read(path.join(out,'corpus-summary.json'));assert(r.passed);assert.equal(r.results.length,14);assert.equal(r.cleanup.appCloseState,'closed');assert(r.cleanup.ownedProcessTerminated);assert.deepEqual(r.runtimeErrors,[]);assert.deepEqual(r.finalizationErrors,[]);
   let checks=0;for(const item of r.results){assert(item.passed&&item.tabsClosed);assert.equal(item.records.length,3);assert.deepEqual(item.errors,[]);assert.deepEqual(item.pageErrors,[]);for(const check of item.records){assert(check.passed);assert.equal(check.diskHash,check.expectedDiskHash);checks++;}assert.equal(hash(item.evidence.finalFile),item.evidence.sha256);assert.equal(fs.statSync(item.evidence.finalFile).size,item.evidence.bytes);}
   assert.equal(checks,42);report.corpus={files:14,editSaveChecks:checks,durationMs:r.durationMs,peakWorkingSetBytes:r.peakWorkingSetBytes};
  }
  if(name==='workspace'){
   const r=read(path.join(out,'workspace-stress.json'));assert(r.passed);assert.equal(r.notes,20000);assert.equal(r.images,4200);assert.deepEqual(r.writerErrors,[]);assert(r.tempFilesCreatedAndDeleted>0);assert(r.cleanup.writerOk);assert(r.cleanup.ownedProcessTerminated);report.workspace={notes:r.notes,images:r.images,writerOperations:r.tempFilesCreatedAndDeleted,durationMs:r.durationMs};
  }
  save();
 }
 assert.equal(report.stages.length,14);report.passed=true;save();console.log(JSON.stringify(report,null,2));
}catch(error){report.error=String(error.stack||error);save();throw error;}

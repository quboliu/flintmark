import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const read=p=>JSON.parse(fs.readFileSync(p));
const candidate=read('candidate/manifest.json');
const systems={'ubuntu-24.04':['linux','x64'],'windows-2025':['win32','x64'],'windows-11-arm':['win32','arm64'],'macos-15':['darwin','arm64']};
const rows=[];
function summaries(root){let found=[];for(const entry of fs.readdirSync(root,{withFileTypes:true})){const full=path.join(root,entry.name);if(entry.isDirectory())found.push(...summaries(full));else if(entry.name==='summary.json')found.push(full);}return found;}
for(const [os,[platform,arch]]of Object.entries(systems))for(const editor of ['vscode','vscodium','cursor']){
 const files=summaries(`acceptance-evidence/acceptance-${os}-${editor}`);assert.equal(files.length,1,`${os}/${editor}: exactly one summary`);const r=read(files[0]);
 assert.equal(r.diagnosticOrder,undefined,"Diagnostic ordering is not release acceptance");assert.equal(r.passed,true);if(platform==='win32')assert(r.desktop?.sessionId>0&&r.desktop.interactive&&r.desktop.width>0&&r.desktop.height>0);assert.equal(r.platform,platform);assert.equal(r.arch,arch);assert.equal(r.editor,editor);assert.equal(r.sourceCommit,candidate.sourceCommit);assert.equal(r.vsixSha256,candidate.vsixSha256);
 assert.deepEqual(r.stages.map(x=>x.name),['integration','save-barrier','native-scroll','observer-controls','livepreview-viewport-clock','todo-strict','external-update-command-map','theme-mode','image-index-lifecycle','issue-regressions','panel-sync-preserve-focus','crlf-boundaries','corpus','workspace']);assert(r.stages.every(x=>x.exitCode===0));assert.equal(r.saveBarrier.cases,10);assert.equal(r.corpus.files,14);assert.equal(r.corpus.editSaveChecks,42);assert.equal(r.workspace.notes,20000);assert.equal(r.workspace.images,4200);assert(r.workspace.writerOperations>0);assert.equal(r.visibleWheel.gestures,200);assert(r.visibleWheel.maxErrorPx<=1);assert(r.visibleWheel.maxBrowserProgressMs<=500);
 rows.push({os,platform,arch,editor,passed:true,corpus:r.corpus,workspace:r.workspace});
}
assert.equal(rows.length,12);const result={sourceCommit:candidate.sourceCommit,version:candidate.version,vsixSha256:candidate.vsixSha256,rows,passed:true};fs.writeFileSync('acceptance-evidence/verification.json',JSON.stringify(result,null,2)+'\n');
if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`## Full release acceptance passed\n\nAll 12 platform/editor combinations passed with the same VSIX (${candidate.vsixSha256}). Each ran 14 corpus files and 42 edit/save checks, plus 20,000 notes and 4,200 images with continuous file creation/deletion.\n`);
console.log(JSON.stringify(result,null,2));

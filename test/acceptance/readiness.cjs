// Test-only activation gate for functional/corpus tests, never cold-index stress.
if ((process.platform === 'win32' || process.env.FLINTMARK_READY_GATE === '1') && !process.argv[1]?.endsWith('workspace-stress.mjs')) {
  const fs = require('fs'), path = require('path'), { createRequire } = require('module');
  const req = createRequire(path.join(process.env.FLINTMARK_DEPS, 'package.json'));
  const electron = req('playwright')._electron, launch = electron.launch.bind(electron);
  electron.launch = async options => {
    const args = options.args || [], arg = name => args.find(a => a.startsWith(name + '='))?.slice(name.length + 1);
    const profile = arg('--user-data-dir'), extensions = arg('--extensions-dir'), development = arg('--extensionDevelopmentPath') || process.env.FLINTMARK_INSTALLED_EXTENSION_PATH;
    if (!profile || !extensions || !development) throw Error('Readiness requires isolated profiles and a development checkout');
    const initialFile = args.find(a => /\.(md|markdown)$/i.test(a) && fs.existsSync(a) && fs.statSync(a).isFile());
    if (!initialFile && args.some(a => /\.(md|markdown)(?::\d+(?::\d+)?)?$/i.test(a))) throw Error('Unsupported Markdown CLI form in readiness probe');
    const dir = path.join(extensions, 'local-test.flintmark-readiness-1.0.0'); fs.mkdirSync(dir, { recursive: true });
    const ready = path.join(profile, 'flintmark-ready-' + Date.now() + '-' + process.pid + '.json');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'flintmark-readiness', publisher: 'local-test', version: '1.0.0', engines: { vscode: '^1.89.0' }, activationEvents: ['*'], main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), `
const fs=require('fs'),vscode=require('vscode');
const ready=${JSON.stringify(ready)},initialFile=${JSON.stringify(initialFile || null)},development=${JSON.stringify(development)};
const same=(a,b)=>a.toString().toLowerCase()===b.toString().toLowerCase();
function publish(value){fs.writeFileSync(ready+'.tmp',JSON.stringify(value));fs.renameSync(ready+'.tmp',ready);}
exports.activate=async()=>{const phases=[],phase=name=>{phases.push({name,at:Date.now()});fs.writeFileSync(ready+'.phases',JSON.stringify(phases));};try{phase('activation-entry');
 const extension=vscode.extensions.getExtension('quboliu.flintmark');
 if(!extension)throw Error('Flintmark extension is absent');
 if(fs.realpathSync(extension.extensionPath).toLowerCase()!==fs.realpathSync(development).toLowerCase())throw Error('Activated extension is not the candidate checkout');
 phase('plugin-activation-start');await extension.activate();phase('plugin-activation-end');
 let associationVerified=null,initialInputKind=null,initialInputUri=null,reopenedAfterActivation=false;
 phase('association-check-start');if(initialFile){
  const uri=vscode.Uri.file(initialFile);let input=vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  initialInputKind=input instanceof vscode.TabInputCustom?input.viewType:input?.constructor?.name||'none';initialInputUri=input?.uri?.toString()||null;
  const matches=()=>input instanceof vscode.TabInputCustom&&input.viewType==='ofm.livePreview'&&same(input.uri,uri);
  if(!matches()){
   if(input?.uri&&same(input.uri,uri)){const doc=vscode.workspace.textDocuments.find(d=>same(d.uri,uri));if(doc?.isDirty)throw Error('Refusing to close a modified readiness fixture');await vscode.commands.executeCommand('workbench.action.closeActiveEditor');}
   await vscode.commands.executeCommand('vscode.open',uri,{preview:false});reopenedAfterActivation=true;input=vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  }
  associationVerified=matches();if(!associationVerified)throw Error('Standard file open did not select Flintmark for the requested URI');
 }
 phase('ready');publish({status:'ready',editor:vscode.version,pluginVersion:extension.packageJSON.version,pluginActive:extension.isActive,initialFile,associationVerified,initialInputKind,initialInputUri,reopenedAfterActivation});
}catch(error){publish({status:'error',error:String(error)});throw error;}};
`);
    const started = Date.now(), app = await launch({ ...options, timeout: Math.max(options.timeout || 0, 120000) });
    try {
      while (!fs.existsSync(ready) && Date.now() - started < 180000) await new Promise(r => setTimeout(r, 200));
      const result = fs.existsSync(ready) ? JSON.parse(fs.readFileSync(ready, 'utf8')) : { status: 'error', error: 'Extension host readiness timed out after 180 seconds' };
      result.durationMs = Date.now() - started; result.phases = fs.existsSync(ready+'.phases') ? JSON.parse(fs.readFileSync(ready+'.phases','utf8')).map(x=>({phase:x.name,elapsedMs:x.at-started})) : [];
      const out = process.env.FLINTMARK_OUT;
      if (out) { fs.mkdirSync(out, { recursive: true }); fs.appendFileSync(path.join(out, 'startup-readiness.jsonl'), JSON.stringify(result) + '\n'); }
      console.log('EXTENSION_HOST_READINESS', JSON.stringify(result));
      if (result.status !== 'ready' || !result.pluginActive || (initialFile && result.associationVerified !== true)) throw Error(result.error || 'Readiness/association was not confirmed');
      await require(path.join(process.env.FLINTMARK_READY_HELPERS,'editor-onboarding.cjs')).registerEditorOnboarding(app, out);
      return app;
    } catch (error) { app.process()?.kill(); throw error; }
  };
}

// Test-only: install the exact VSIX in an isolated editor profile before launch.
const fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const req=require('module').createRequire(path.join(process.env.FLINTMARK_DEPS,'package.json'));
const electron=req('playwright')._electron,original=electron.launch.bind(electron);
const candidate=JSON.parse(fs.readFileSync(process.env.FLINTMARK_CANDIDATE_MANIFEST));
const expectedVsix=candidate.vsixSha256;
const expectedExtension=candidate.runtime.find(x=>x.path==='out/extension.js').sha256;
const expectedWebview=candidate.runtime.find(x=>x.path==='out/webview.js').sha256;
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const installedProfiles = new Map();
electron.launch=async options=>{
 // Prevent the editor's delayed first-run sign-in dialog from consuming test input.
 options={...options,args:[...(options.args||[]),'--skip-welcome','--skip-release-notes']};
 const args=options.args||[],arg=n=>args.find(a=>a.startsWith(n+'='))?.slice(n.length+1);
 const extensions=arg('--extensions-dir'),profile=arg('--user-data-dir'),vsix=process.env.FLINTMARK_VSIX,out=process.env.FLINTMARK_OUT;
 if(!extensions||!profile||!vsix||!out)throw Error('Installed test requires isolated directories and an explicit VSIX');
 if(hash(vsix)!==expectedVsix)throw Error('VSIX hash differs from the reviewed release artifact');
 const profileKey=JSON.stringify([options.executablePath,profile,extensions]);
 const previous=installedProfiles.get(profileKey);
 if(previous){
  if(hash(path.join(previous,'out','extension.js'))!==expectedExtension || hash(path.join(previous,'out','webview.js'))!==expectedWebview)throw Error('Installed runtime changed before relaunch');
  process.env.FLINTMARK_INSTALLED_EXTENSION_PATH=previous;
  fs.appendFileSync(path.join(out,'installed-relaunches.jsonl'),JSON.stringify({extensionPath:previous,vsixSha256:expectedVsix})+'\n');
  return original({...options,args:args.filter(a=>!a.startsWith('--extensionDevelopmentPath='))});
 }

 let cli=path.join(path.dirname(options.executablePath),...(process.platform==='darwin'?['..','Resources']:['resources']),'app','out','cli.js');
 if(!fs.existsSync(cli)&&process.platform==='win32'){
  const base=path.dirname(options.executablePath), candidates=fs.readdirSync(base,{withFileTypes:true}).filter(x=>x.isDirectory()&&/^[0-9a-f]{10,40}$/i.test(x.name)).map(x=>path.join(base,x.name,'resources','app','out','cli.js')).filter(p=>fs.existsSync(p));
  if(candidates.length===1)cli=candidates[0];
 }
 if(!fs.existsSync(cli))throw Error('Editor CLI missing: '+cli);
 // The CLI maintains extensions.json. Register the diagnostic helper before that
 // scan; windows-readiness fills its script before the actual editor launches.
 if(process.platform==='win32'||process.env.FLINTMARK_READY_GATE==='1'){
  const helper=path.join(extensions,'local-test.flintmark-readiness-1.0.0');fs.mkdirSync(helper,{recursive:true});
  fs.writeFileSync(path.join(helper,'package.json'),JSON.stringify({name:'flintmark-readiness',publisher:'local-test',version:'1.0.0',engines:{vscode:'^1.89.0'},activationEvents:['*'],main:'index.js'}));
  const entry=path.join(helper,'index.js');
  if(fs.existsSync(entry)&&fs.readFileSync(entry,'utf8').includes('exports.activate'))throw Error('Wrong wrapper order: require windows-readiness before installed-candidate');
  fs.writeFileSync(entry,'// Readiness implementation is populated before GUI launch.\n');
 }
 fs.mkdirSync(out,{recursive:true});const fd=fs.openSync(path.join(out,'install.log'),'w');
 const install=cp.spawnSync(options.executablePath,[cli,'--user-data-dir='+profile,'--extensions-dir='+extensions,'--install-extension',vsix,'--force'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore',fd,fd],timeout:240000});fs.closeSync(fd);
 if(install.status!==0)throw Error('VSIX installation failed: '+JSON.stringify({status:install.status,signal:install.signal,error:install.error?.message}));
 if(process.platform==='win32'||process.env.FLINTMARK_READY_GATE==='1'){
  const registry=JSON.parse(fs.readFileSync(path.join(extensions,'extensions.json'),'utf8'));
  fs.writeFileSync(path.join(out,'extension-registration.json'),JSON.stringify({requireOrder:process.execArgv,extensions:registry.map(x=>({id:x.identifier?.id,version:x.version}))},null,2));
  if(!registry.some(x=>x.identifier?.id==='local-test.flintmark-readiness'))throw Error('Readiness helper was not registered by the editor CLI');
 }

 const found=fs.readdirSync(extensions).map(n=>path.join(extensions,n,'package.json')).filter(p=>fs.existsSync(p)).map(p=>({path:p,manifest:JSON.parse(fs.readFileSync(p))})).filter(x=>x.manifest.publisher==='quboliu'&&x.manifest.name==='flintmark');
 if(found.length!==1||found[0].manifest.version!==candidate.version)throw Error('Installed candidate identity mismatch');
 if(hash(path.join(path.dirname(found[0].path),'out','extension.js'))!==expectedExtension)throw Error('Installed extension bundle hash mismatch');
 if(hash(path.join(path.dirname(found[0].path),'out','webview.js'))!==expectedWebview)throw Error('Installed webview hash mismatch');
 for(const file of candidate.runtime){if(hash(path.join(path.dirname(found[0].path),file.path))!==file.sha256)throw Error('Installed runtime mismatch: '+file.path);}
 fs.writeFileSync(path.join(out,'installed-candidate.json'),JSON.stringify({version:found[0].manifest.version,extensionPath:path.dirname(found[0].path),vsixSha256:hash(vsix),extensionSha256:hash(path.join(path.dirname(found[0].path),'out','extension.js')),developmentMode:false},null,2));
 installedProfiles.set(profileKey,path.dirname(found[0].path));
 process.env.FLINTMARK_INSTALLED_EXTENSION_PATH=path.dirname(found[0].path);
 return original({...options,args:args.filter(a=>!a.startsWith('--extensionDevelopmentPath='))});
};

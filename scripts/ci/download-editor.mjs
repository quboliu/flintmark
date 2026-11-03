import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const editor=process.argv[2], platform=process.platform, arch=process.arch;
assert(['vscode','vscodium','cursor'].includes(editor),'Select vscode, vscodium, or cursor');
assert(['linux-x64','linux-arm64','win32-x64','win32-arm64','darwin-arm64'].includes(`${platform}-${arch}`));
const root=path.join(process.env.RUNNER_TEMP||os.tmpdir(),'flintmark-editors',editor);
fs.mkdirSync(root,{recursive:true});
const versions={vscode:'1.144.0',vscodium:'1.143.17232',cursor:'3.27.22'};
const cursorCommit='b1aa50cb6db84fd3e8c808259cb172ea73425c1f';
const ext=platform==='linux'?(editor==='cursor'?'deb':'tar.gz'):platform==='darwin'&&editor==='cursor'?'dmg':platform==='win32'&&editor==='cursor'?'exe':'zip';
let url;
if(editor==='vscode'){
  const target=platform==='win32'?`win32-${arch}-archive`:`${platform}-${arch}`;
  url=`https://update.code.visualstudio.com/${versions.vscode}/${target}/stable`;
}else if(editor==='vscodium'){
  url=`https://github.com/VSCodium/vscodium/releases/download/${versions.vscodium}/VSCodium-${platform}-${arch}-${versions.vscodium}.${ext}`;
}else{
  const target=platform==='linux'?`linux/${arch}/deb/${arch==='x64'?'amd64':'arm64'}/deb/cursor_${versions.cursor}_${arch==='x64'?'amd64':'arm64'}.deb`:platform==='darwin'?`darwin/${arch}/Cursor-darwin-${arch}.dmg`:`win32/${arch}/user-setup/CursorUserSetup-${arch}-${versions.cursor}.exe`;
  url=`https://downloads.cursor.com/production/${cursorCommit}/${target}`;
}
const archive=path.join(root,'download.'+ext), app=path.join(root,'app');fs.mkdirSync(app,{recursive:true});
execFileSync(platform==='win32'?'curl.exe':'curl',['--fail','--location','--retry','3','--silent','--show-error',url,'--output',archive],{stdio:'inherit',timeout:600000});
const sha256=createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
const psEnv={...process.env};for(const key of Object.keys(psEnv))if(key.toLowerCase()==='psmodulepath')delete psEnv[key];
const ps=code=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';"+code,'utf16le').toString('base64')],{stdio:'inherit',timeout:300000,env:psEnv});
const quote=value=>"'"+value.replaceAll("'","''")+"'";
if(ext==='tar.gz')execFileSync('tar',['-xzf',archive,'-C',app,...(editor==='vscode'?['--strip-components=1']:[])],{stdio:'inherit'});
else if(ext==='deb')execFileSync('dpkg-deb',['-x',archive,app],{stdio:'inherit'});
else if(ext==='zip'&&platform==='win32')ps(`Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(app)}`);
else if(ext==='zip')execFileSync('ditto',['-xk',archive,app],{stdio:'inherit'});
else if(ext==='exe')ps(`$sig=Get-AuthenticodeSignature ${quote(archive)};if($sig.Status -ne 'Valid'){throw 'Invalid editor installer signature'};$p=Start-Process -FilePath ${quote(archive)} -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-',${quote('/DIR="'+app+'"')},'/MERGETASKS=!runcode,!desktopicon,!quicklaunchicon,!addtopath') -Wait -PassThru;if($p.ExitCode -ne 0){throw "Installer exit $($p.ExitCode)"}`);
else {
  const mount=path.join(root,'mount');fs.mkdirSync(mount,{recursive:true});
  execFileSync('hdiutil',['attach',archive,'-readonly','-nobrowse','-mountpoint',mount],{stdio:'inherit'});
  try{execFileSync('ditto',[path.join(mount,'Cursor.app'),path.join(app,'Cursor.app')],{stdio:'inherit'});}finally{execFileSync('hdiutil',['detach',mount],{stdio:'inherit'});}
}
const names={vscode:platform==='darwin'?'Visual Studio Code.app/Contents/MacOS/Electron':platform==='win32'?'Code.exe':'code',vscodium:platform==='darwin'?'VSCodium.app/Contents/MacOS/Electron':platform==='win32'?'VSCodium.exe':'codium',cursor:platform==='darwin'?'Cursor.app/Contents/MacOS/Cursor':platform==='win32'?'Cursor.exe':'usr/share/cursor/cursor'};
let executable=path.join(app,names[editor]);
if(platform==='darwin'&&!fs.existsSync(executable)){
  const macos=path.dirname(executable), names=fs.readdirSync(macos).filter(n=>fs.statSync(path.join(macos,n)).isFile());assert.equal(names.length,1);executable=path.join(macos,names[0]);
}
assert(fs.existsSync(executable),'Editor executable was extracted');
const record={editor,version:versions[editor],platform,arch,url,sha256,executable};
fs.mkdirSync('out/acceptance',{recursive:true});fs.writeFileSync('out/acceptance/editor.json',JSON.stringify(record,null,2)+'\n');
if(process.env.GITHUB_ENV)fs.appendFileSync(process.env.GITHUB_ENV,`VSCODE_BIN=${executable}\nFLINTMARK_EDITOR=${editor}\n`);
console.log(JSON.stringify(record,null,2));

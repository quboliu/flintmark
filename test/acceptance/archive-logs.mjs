import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

function manifest(root) {
  const rows=[];
  function visit(relative) {
    const full=path.join(root,relative),stat=fs.lstatSync(full);
    if(stat.isDirectory()) {
      rows.push({path:relative,type:'directory'});
      for(const name of fs.readdirSync(full).sort()) visit(path.join(relative,name));
    } else if(stat.isFile()) {
      const bytes=fs.readFileSync(full);
      rows.push({path:relative,type:'file',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    } else throw Error('Unexpected log entry type: '+full);
  }
  visit('');
  return rows;
}

// Node 24's native cpSyncCopyDir fails with EACCES on this VirtioFS share.
// The explicit filter uses Node's ordinary recursive copy path. No failure is
// ignored: source stability and every destination file/directory are verified.
export function archiveLogs(source,destination) {
  assert.ok(!fs.existsSync(destination),'Log archive must be fresh');
  const before=manifest(source);
  fs.cpSync(source,destination,{recursive:true,filter:()=>true,errorOnExist:true,force:false});
  const after=manifest(source),copied=manifest(destination);
  assert.deepEqual(after,before,'Host logs changed during archival');
  assert.deepEqual(copied,before,'Host log archive differs from source');
  fs.writeFileSync(destination+'-manifest.json',JSON.stringify({source,destination,files:before.filter(x=>x.type==='file').length,entries:before,verified:true},null,2),{flag:'wx'});
  return before;
}

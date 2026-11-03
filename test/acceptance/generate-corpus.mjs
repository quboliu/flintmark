import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
const out=process.env.FLINTMARK_CORPUS; if(!out)throw Error('FLINTMARK_CORPUS is required'); mkdirSync(out,{recursive:true});
const blocks={
prose:['## Nested heading','', 'A paragraph with **bold**, _italic_, [link](https://example.com), and `code`.',''],
unicode:['## Unicode \u65e5\u672c\u8a9e \u4e2d\u6587 \ud83d\ude80 e\u0301','', 'Astral: \ud83e\udded\ud83d\udc69\u200d\ud83d\udcbb; combining: a\u0301o\u0308; RTL: \u05e9\u05dc\u05d5\u05dd.',''],
lists:['- parent','  - child','    - [ ] nested task','      1. deeper','- [x] done',''],
tables:['| Name | Value | Link |','| --- | ---: | --- |','| escaped \\| pipe | 42 | [[target]] |','| `code` | **bold** | [link](target.md) |',''],
code:['```typescript','const text = "\\r\\n";','// Markdown inside code: - [ ] # | **','```',''],
media:['![pixel](pixel.png)','', '> [!note] Callout','> Embedded **text** and $x^2$.','', '$$','a^2 + b^2 = c^2','$$',''],
longline:['L'.repeat(32768)+' \ud83d\ude80 tail',''],
malformed:['```unterminated','| broken | table','[[unfinished','![missing](not-found.png)','<div>',''],
};
const manifest=[];
for(const [kind,block] of Object.entries(blocks))for(const eol of ['LF','CRLF'])for(const trailing of [true,false]){
 const lines=['# Fixture '+kind+' '+eol+' '+trailing,'','---','title: Boundary fixture','---','',...block,...block,'END SENTINEL'];if(trailing)lines.push('');
 const text=lines.join(eol==='LF'?'\n':'\r\n');const name=kind+'-'+eol+'-'+trailing+'.md';writeFileSync(join(out,name),text);manifest.push({name,bytes:Buffer.byteLength(text),lines:lines.length,kind,eol,trailing});
}
for(const sizeMiB of [1,5,12])for(const eol of ['LF','CRLF']){
 const sep=eol==='LF'?'\n':'\r\n';const chunk=['## Section','','Paragraph with **bold**, `code`, \ud83d\ude80, e\u0301, and [link](target.md).','- [ ] task one','- [x] task two','',...blocks.tables,...blocks.code,...blocks.unicode].join(sep)+sep;
 const n=Math.ceil(sizeMiB*1024*1024/Buffer.byteLength(chunk));const name='large-'+sizeMiB+'MiB-'+eol+'.md';const text='# Large '+sizeMiB+' '+eol+sep+sep+chunk.repeat(n)+'END SENTINEL'+sep;
 writeFileSync(join(out,name),text);manifest.push({name,bytes:Buffer.byteLength(text),lines:text.split('\n').length,kind:'large',eol,sizeMiB});
}
writeFileSync(join(out,'pixel.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64'));
writeFileSync(join(out,'target.md'),'# Link target\n');writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({files:manifest.length,totalBytes:manifest.reduce((n,x)=>n+x.bytes,0),largest:manifest.at(-1)}));

import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
export async function capture(win,label,extra={}) {
 const root=path.join(process.env.FLINTMARK_OUT,'diagnostics');fs.mkdirSync(root,{recursive:true});
 const data={label,wallMs:Date.now(),monotonicMs:performance.now(),...extra};
 const bounded=async (fn)=>{let timer;try{return await Promise.race([fn(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Capture exceeded 5000ms')),5000)})]);}catch(e){return {captureError:String(e)}}finally{clearTimeout(timer)}};
 data.host=await bounded(()=>win.evaluate(()=>({active:document.activeElement?.outerHTML?.slice(0,1500),tabs:[...document.querySelectorAll('.tab')].map(e=>({text:e.textContent,active:e.classList.contains('active')})),native:!!document.querySelector('.monaco-editor .view-lines')})));
 data.frames=[];
 for(const f of win.frames())data.frames.push(await bounded(()=>f.evaluate(()=>{const e=document.querySelector('.cm-content'),v=e?.cmTile?.root?.view||e?.cmView?.view||e?.parentElement?.cmView?.view;return {imageMaps:window.__fmImageMaps,focusTrace:window.__fmFocusTrace,url:location.href,active:document.activeElement?.outerHTML?.slice(0,1500),text:v?.state.doc.toString(),selection:v?.state.selection.toJSON(),hasFocus:v?.hasFocus,images:[...document.images].map(i=>({src:i.src,complete:i.complete,width:i.naturalWidth,height:i.naturalHeight})),checkboxes:[...document.querySelectorAll('input[type=checkbox]')].map(e=>({checked:e.checked,task:e.dataset.task}))}})));
 fs.writeFileSync(path.join(root,label+'.json'),JSON.stringify(data,null,2));
 if(extra.captureScreenshot!==false)await bounded(()=>win.screenshot({path:path.join(root,label+'.png'),timeout:5000}));return data;
}

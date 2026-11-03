export function installNativeAnchorTrace(targetPos) {
  const view = document.querySelector('.cm-content')?.cmTile?.root?.view;
  if (!view?.viewState || !view.scrollDOM) throw Error('No real CodeMirror view');
  const vs = view.viewState, scroller = view.scrollDOM;
  function typography() {
    const node=view.domAtPos(targetPos).node;
    const parent=node.nodeType===1?node:node.parentElement;
    const wantedLine=view.state.doc.lineAt(targetPos).number;
    const line=parent.closest('.cm-line') || [...view.contentDOM.querySelectorAll('.cm-line')].find(element=>view.state.doc.lineAt(view.posAtDOM(element)).number===wantedLine);
    if(!line)return {missing:true,targetPos,viewport:view.viewport,scrollTop:view.scrollDOM.scrollTop,block:view.lineBlockAt(targetPos)};
    const properties=['font-family','font-size','font-weight','font-style','line-height','letter-spacing','padding-top','padding-bottom','border-top-width','border-bottom-width','box-sizing'];
    const styles=element=>Object.fromEntries(properties.map(name=>[name,getComputedStyle(element).getPropertyValue(name)]));
    const rect=line.getBoundingClientRect(),coords=view.coordsAtPos(targetPos);
    return {line:styles(line),glyph:styles(parent),text:line.textContent,actual:{lineHeight:rect.height,glyphTop:coords.top-rect.top,glyphHeight:coords.bottom-coords.top}};
  }
  const beforeTypography=typography();
  const events = [], restorers = [], start = performance.now();
  let depth = 0, cycle = 0;
  function record(kind, data) { if (events.length < 6000) events.push({t:performance.now()-start,cycle,kind,...data}); }
  function state() {return {scrollTop:scroller.scrollTop, scrollOffset:vs.scrollOffset, anchorPos:vs.scrollAnchorPos, anchorHeight:vs.scrollAnchorHeight, mapHeight:vs.heightMap.height, printing:vs.printing, mustMeasureContent:vs.mustMeasureContent, lineHeight:vs.heightOracle.lineHeight, scaleY:view.scaleY, requests:view.measureRequests.length};}
  function wrap(object, name, make) { const own=Object.getOwnPropertyDescriptor(object,name), original=object[name]; if(typeof original!=='function')throw Error('Missing method '+name);object[name]=make(original);restorers.push(()=>{if(own)Object.defineProperty(object,name,own);else delete object[name];}); }
  let proto=scroller, descriptor;
  while(proto&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(proto,'scrollTop');proto=Object.getPrototypeOf(proto);}
  if(!descriptor?.get||!descriptor?.set)throw Error('Missing native scrollTop accessors');
  const ownScroll=Object.getOwnPropertyDescriptor(scroller,'scrollTop');
  Object.defineProperty(scroller,'scrollTop',{configurable:true,get(){return descriptor.get.call(this);},set(value){const before=descriptor.get.call(this);descriptor.set.call(this,value);const actual=descriptor.get.call(this);record('scroll-write',{requested:value,before,actual,roundingError:actual-value,stack:new Error().stack?.split('\n').slice(1,8)});}});
  restorers.push(()=>{if(ownScroll)Object.defineProperty(scroller,'scrollTop',ownScroll);else delete scroller.scrollTop;});
  wrap(view,'measure',original=>function(...args){cycle++;depth++;record('measure-start',state());try{return original.apply(this,args);}finally{record('measure-end',state());depth--;}});
  wrap(vs,'measure',original=>function(...args){record('state-measure-before',state());const result=original.apply(this,args);record('state-measure-after',{...state(),changed:result});return result;});
  wrap(vs,'scrollAnchorAt',original=>function(offset){const result=original.call(this,offset);record('choose-anchor',{offset,from:result.from,top:result.top,height:result.height});return result;});
  wrap(vs,'lineBlockAt',original=>function(pos){const result=original.call(this,pos);if(depth)record('block-read',{pos,from:result.from,top:result.top,height:result.height});return result;});
  wrap(vs.heightOracle,'refresh',original=>function(...args){const before=this.lineHeight;const result=original.apply(this,args);record('oracle-refresh',{args:args.map(x=>typeof x==='object'?'object':x),before,after:this.lineHeight,result});return result;});
  record('trace-start',{...state(),targetPos,devicePixelRatio,visualViewportScale:visualViewport?.scale,selection:view.state.selection.toJSON()});
  window.__fmNativeAnchorTrace={events,targetPos,finish(){record('trace-end',{...state(),selection:view.state.selection.toJSON()});for(const restore of restorers.reverse())restore();const afterTypography=typography();
    function plainTextControl(sample){if(!sample.text)return {skipped:true,reason:'empty source line has no glyph to measure'};if(sample.missing)return {skipped:true,reason:'target line is outside the mounted viewport'};const box=document.createElement('div'),span=document.createElement('span');box.style.cssText='position:fixed;left:-10000px;top:0;width:1000px;margin:0;border-style:solid;white-space:pre;';for(const[k,v]of Object.entries(sample.line))box.style.setProperty(k,v);for(const[k,v]of Object.entries(sample.glyph))if(k.startsWith('font')||k==='letter-spacing')span.style.setProperty(k,v);span.textContent=sample.text;box.appendChild(span);document.body.appendChild(box);const range=document.createRange();range.setStart(span.firstChild,0);range.setEnd(span.firstChild,1);const rect=box.getBoundingClientRect(),glyph=range.getBoundingClientRect();const result={lineHeight:rect.height,glyphTop:glyph.top-rect.top,glyphHeight:glyph.height};box.remove();return result;}
    const fontControls={before:{...beforeTypography,plain:plainTextControl(beforeTypography),plainWithoutPadding:plainTextControl({...beforeTypography,line:{...beforeTypography.line,'padding-top':'0px','padding-bottom':'0px'}})},after:{...afterTypography,plain:plainTextControl(afterTypography),plainWithoutPadding:plainTextControl({...afterTypography,line:{...afterTypography.line,'padding-top':'0px','padding-bottom':'0px'}})}};
    const div=document.createElement('div'),child=document.createElement('div');div.style.cssText='position:fixed;left:-10000px;top:0;width:100px;height:20px;overflow:scroll;';child.style.height='1000px';div.appendChild(child);document.body.appendChild(div);const quantization=[];for(const delta of [0,0.125,0.25,0.375,0.5,0.625,0.75,0.875,1]){div.scrollTop=100+delta;quantization.push({requested:100+delta,actual:div.scrollTop});}div.remove();return {diagnosticOnly:true,instrumentation:'cached state and native scroll writes; no geometry reads inside measure wrappers',events,fontControls,quantization,devicePixelRatio,visualViewportScale:visualViewport?.scale};}};
}

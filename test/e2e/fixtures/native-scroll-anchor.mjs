import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

const resize = StateEffect.define();
class Spacer extends WidgetType {
  constructor(height) { super(); this.height = height; }
  eq(other) { return this.height === other.height; }
  get estimatedHeight() { return this.height; }
  toDOM() {
    const element = document.createElement('div');
    element.style.height = `${this.height}px`;
    return element;
  }
}
const decorations = height => Decoration.set([
  Decoration.widget({ widget: new Spacer(height), block: true, side: -1 }).range(0),
]);
const spacer = StateField.define({
  create: () => decorations(2000),
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(resize)) return decorations(effect.value);
    return value.map(transaction.changes);
  },
  provide: field => EditorView.decorations.from(field),
});
const theme = EditorView.theme({
  '&': { height: '400px', width: '800px' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-content': { fontFamily: 'monospace', fontSize: '14px', lineHeight: '20px', padding: '0' },
  '.cm-line': { padding: '0' },
});
let view;
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise(requestAnimationFrame);
}
function sample(pos) {
  const block = view.lineBlockAt(pos);
  return {
    pos,
    text: view.state.doc.lineAt(pos).text,
    margin: view.documentTop + block.top - view.scrollDOM.getBoundingClientRect().top,
    scrollTop: view.scrollDOM.scrollTop,
    selection: view.state.selection.toJSON(),
  };
}
async function create(scale) {
  view?.destroy();
  document.body.replaceChildren();
  view = new EditorView({
    state: EditorState.create({
      doc: Array.from({ length: 300 }, (_, i) => `Source line ${String(i + 1).padStart(3, '0')} preserves its identity.`).join('\n'),
      extensions: [spacer, theme],
    }),
    parent: document.body,
  });
  view.dom.style.transformOrigin = 'top left';
  view.dom.style.transform = `scaleY(${scale})`;
  view.requestMeasure();
  await settle();
  const pos = view.state.doc.line(220).from;
  view.scrollDOM.scrollTop = (view.lineBlockAt(pos).top - 24) / view.scaleY;
  view.requestMeasure();
  await settle();
  return sample(pos);
}
async function run(kind, scale) {
  const before = await create(scale), samples = [];
  let pos = before.pos;
  if (kind === 'shrink-before-measure') {
    view.dispatch({ effects: resize.of(0) });
    // Force browser layout/clamping before the scheduled editor measurement.
    void view.scrollDOM.scrollHeight;
    await settle();
    samples.push(sample(pos));
  } else if (kind === 'fractional-changes') {
    for (let i = 1; i <= 24; i++) {
      view.dispatch({ effects: resize.of(2000 + i / 8) });
      await settle();
      samples.push(sample(pos));
    }
  } else if (kind === 'round-trips') {
    for (let i = 0; i < 12; i++) for (const height of [1800.375, 2000]) {
      view.dispatch({ effects: resize.of(height) });
      await settle();
      samples.push(sample(pos));
    }
  } else if (kind === 'set-state-immediate-edit') {
    view.setState(EditorState.create({ doc: 'Replacement document.', extensions: [theme] }));
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' Edited.' } });
    await settle();
    return { kind, scale, pass: view.state.doc.toString() === 'Replacement document. Edited.' };
  } else if (kind === 'edit-before-anchor') {
    const insert = 'Inserted first line.\n';
    view.dispatch({ changes: { from: 0, insert } });
    pos += insert.length;
    await settle();
    samples.push(sample(pos));
  } else if (kind === 'snapshot-restore') {
    const snapshot = view.scrollSnapshot();
    view.scrollDOM.scrollTop = 0;
    view.requestMeasure();
    await settle();
    view.dispatch({ effects: snapshot });
    await settle();
    samples.push(sample(pos));
  } else if (kind === 'explicit-navigation') {
    pos = view.state.doc.line(30).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }) });
    await settle();
    const target = sample(pos);
    view.requestMeasure();
    await settle();
    const after = sample(pos);
    // Native navigation targets text coordinates, which differ from block tops.
    // Assert visibility and stability, not an invented exact block-top margin.
    return { kind, scale, target, after, pass: view.state.selection.main.head === pos &&
      target.margin >= 0 && target.margin < 40 && Math.abs(after.margin - target.margin) <= 1 };
  } else throw Error(`Unknown case: ${kind}`);
  const maxDrift = Math.max(...samples.map(value => Math.abs(value.margin - before.margin)));
  return { kind, scale, before, samples, maxDrift, pass: Number.isFinite(maxDrift) && maxDrift <= 1 &&
    samples.every(value => value.text === before.text && JSON.stringify(value.selection) === JSON.stringify(before.selection)) };
}
window.anchorRegression = { run };

window.anchorRegression.boundary = async function(kind, scale) {
  const initial=await create(scale),steps=[];
  const maximum=()=>view.scrollDOM.scrollHeight-view.scrollDOM.clientHeight;
  if(kind==='top'||kind==='bottom') {
    view.scrollDOM.scrollTop=kind==='top'?0:maximum();view.requestMeasure();await settle();
    for(const height of [0,2300.125,2000]) {
      view.dispatch({effects:resize.of(height)});void view.scrollDOM.scrollHeight;await settle();
      steps.push({height,scrollTop:view.scrollDOM.scrollTop,max:maximum()});
    }
    return {kind,scale,steps,pass:steps.every(row=>Math.abs(kind==='top'?row.scrollTop:row.max-row.scrollTop)<=1)};
  }
  if(kind==='outer'||kind==='outer-scaled-parent'||kind==='window') {
    view.dom.style.height='auto';view.scrollDOM.style.overflow='visible';
    let scroller;
    if(kind!=='window') {
      scroller=document.createElement('div');scroller.style.cssText='height:400px;overflow:auto;border:0;position:relative';
      document.body.append(scroller);scroller.append(view.dom);
      if(kind==='outer-scaled-parent'){scroller.style.transformOrigin='top left';scroller.style.transform='scaleY(0.75)';}
    } else {
      scroller=document.scrollingElement;
    }
    view.requestMeasure();await settle();view.focus();await settle();
    const pos=view.state.doc.line(220).from;
    const margin=()=>view.documentTop+view.lineBlockAt(pos).top-(kind!=='window'?scroller.getBoundingClientRect().top:0);
    scroller.scrollTop+=(margin()-24)/(kind==='outer-scaled-parent'?0.75:1);view.requestMeasure();await settle();
    const before={margin:margin(),actual:scroller.scrollTop,scrollParent:view.viewState.scrollParent===scroller?'expected':view.viewState.scrollParent===view.scrollDOM?'internal':view.viewState.scrollParent?'other':'window'};
    for(const height of [0,2300.125,2000]){
      view.dispatch({effects:resize.of(height)});void scroller.scrollHeight;await settle();
      steps.push({height,margin:margin(),actual:scroller.scrollTop});
    }
    return {kind,scale,before,steps,pass:steps.every(row=>Math.abs(row.margin-before.margin)<=1)};
  }
  if(kind==='unattainable-target') {
    const pos=view.state.doc.line(300).from;
    view.dispatch({selection:{anchor:pos},effects:EditorView.scrollIntoView(pos,{y:'start',yMargin:24})});await settle();
    for(const height of [0,2300.125,2000]) {
      view.dispatch({effects:resize.of(height)});void view.scrollDOM.scrollHeight;await settle();
      const rect=view.scrollDOM.getBoundingClientRect();
      steps.push({height,scrollTop:view.scrollDOM.scrollTop,max:maximum(),margin:view.documentTop+view.lineBlockAt(pos).top-rect.top,viewportHeight:rect.height,selection:view.state.selection.main.head});
    }
    return {kind,scale,steps,pass:steps.every(row=>Math.abs(row.max-row.scrollTop)<=1&&row.selection===pos&&row.margin>=0&&row.margin<row.viewportHeight)};
  }
  throw Error('Unknown boundary');
};

const runInternal = window.anchorRegression.run;
window.anchorRegression.run = (kind, scale) =>
  ['top', 'bottom', 'outer', 'window', 'outer-scaled-parent', 'unattainable-target'].includes(kind)
    ? window.anchorRegression.boundary(kind, scale) : runInternal(kind, scale);

// Inject physical movement at deterministic points inside the synchronous measure
// cycle. This models a compositor scroll commit without flushing measurement via
// coordinate APIs. A scroll already committed must survive anchor restoration.
window.anchorRegression.motion = async function(kind, scale) {
  await create(scale);
  const phase = kind.includes('-late-') ? 'late' : kind.includes('-write-') ? 'write' : 'read';
  const delta = kind.endsWith('-up') ? -300 : 300;
  const resizeTo = kind.includes('-unchanged-') ? 2000 : 1800;
  let scroller = view.scrollDOM, parentScale = scale;
  const external = kind.includes('-outer-') || kind.includes('-window-');
  if (external) {
    view.dom.style.height = 'auto'; view.scrollDOM.style.overflow = 'visible';
    if (kind.includes('-outer-')) {
      scroller = document.createElement('div');
      scroller.style.cssText = 'height:400px;overflow:auto;position:relative;transform-origin:top left;transform:scaleY(0.75)';
      document.body.append(scroller); scroller.append(view.dom); parentScale = 0.75;
    } else { scroller = document.scrollingElement; parentScale = 1; }
    view.requestMeasure(); await settle(); view.focus(); await settle();
    const pos = view.state.doc.line(220).from;
    const top = kind.includes('-outer-') ? scroller.getBoundingClientRect().top : 0;
    scroller.scrollTop += (view.documentTop + view.lineBlockAt(pos).top - top - 24) / parentScale;
    view.requestMeasure(); await settle();
  } else if (kind.includes('-bottom-')) {
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
    view.requestMeasure(); await settle();
  }
  const before = {...sample(view.state.doc.line(220).from), scrollTop: scroller.scrollTop};
  const selection = JSON.stringify(view.state.selection.toJSON());
  let injected = false;
  const inject = () => {
    if (!injected) {
      scroller.scrollTop += delta;
      injected = true;
    }
  };
  const measure = view.viewState.measure;
  const offset = view.viewState.getScrollOffset;
  // A geometry read may synchronize scrolling after the measure/write hooks.
  if (phase === 'late') view.viewState.getScrollOffset = function(...args) {
    if (view.updateState === 2) inject();
    return offset.apply(this, args);
  };
  if (phase === 'read') view.viewState.measure = function(...args) {
    inject();
    return measure.apply(this, args);
  };
  else if (phase === 'write') view.requestMeasure({read: () => null, write: inject});
  try {
    view.dispatch({effects: resize.of(resizeTo)});
    view.requestMeasure();
    await settle();
    const after = {...sample(before.pos), scrollTop: scroller.scrollTop};
    const layoutDelta = (resizeTo - 2000) * (external ? view.scaleY / parentScale : 1);
    const expectedScrollTop = before.scrollTop + layoutDelta + delta;
    const stable = [];
    for (let i = 0; i < 3; i++) {
      view.requestMeasure();
      await settle();
      stable.push(scroller.scrollTop);
    }
    return {kind, scale, phase, delta, before, after, expectedScrollTop, injected, stable,
      pass: injected && Math.abs(after.scrollTop - expectedScrollTop) <= 1 &&
        stable.every(top => Math.abs(top - expectedScrollTop) <= 1) &&
        JSON.stringify(view.state.selection.toJSON()) === selection};
  } finally {
    view.viewState.measure = measure;
    view.viewState.getScrollOffset = offset;
  }
};
const runWithBoundaries = window.anchorRegression.run;
window.anchorRegression.run = (kind, scale) => kind.startsWith('motion-')
  ? window.anchorRegression.motion(kind, scale) : runWithBoundaries(kind, scale);

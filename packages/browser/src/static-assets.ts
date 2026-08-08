import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const bundleRequire = createRequire(import.meta.url);
const require = createRequire(bundleRequire.resolve("@senawa/browser"));

export const dagreJs = readFileSync(require.resolve("dagre/dist/dagre.min.js"), "utf8");
export const cytoscapeJs = readFileSync(require.resolve("cytoscape/dist/cytoscape.min.js"), "utf8");
export const cytoscapeDagreJs = readFileSync(
  require.resolve("cytoscape-dagre/cytoscape-dagre.js"),
  "utf8",
);

export const indexHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Senawa Run Console</title>
  <link rel="stylesheet" href="/styles.css">
  <script src="/dagre.js" defer></script>
  <script src="/cytoscape.js" defer></script>
  <script src="/cytoscape-dagre.js" defer></script>
  <script src="/app.js" defer></script>
</head>
<body>
  <header class="topbar">
    <div><strong>SENAWA</strong><span>Run console</span></div>
    <div><span id="connection">Connecting</span><b id="run-status">Loading</b></div>
  </header>
  <main class="workspace" id="workspace" data-left="expanded" data-right="expanded">
    <aside class="overview rail" id="overview">
      <div class="rail-head">
        <button id="overview-toggle" class="rail-toggle" type="button" aria-expanded="true" aria-controls="overview-body" aria-label="Collapse overview rail">&lsaquo;</button>
        <span class="rail-spine" aria-hidden="true">OVERVIEW</span>
      </div>
      <div class="rail-body" id="overview-body">
        <small>ACTIVE WORKFLOW</small>
        <h1 id="workflow-name">Loading run</h1>
        <dl>
          <div><dt>Phases</dt><dd id="phase-progress">-</dd></div>
          <div><dt>Active</dt><dd id="active-phase">-</dd></div>
          <div><dt>Cursor</dt><dd id="event-cursor">0</dd></div>
        </dl>
      </div>
    </aside>
    <div id="splitter-left" class="splitter" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="overview" aria-label="Resize overview rail" aria-valuemin="180" aria-valuemax="640" aria-valuenow="220"></div>
    <section class="stage">
      <header><small>WORKFLOW GRAPH</small><h2>Execution path</h2></header>
      <div id="graph" class="graph" aria-label="Workflow dependency graph"></div>
      <hr>
      <header><small>AGENT OUTPUT</small><h2 id="console-title">Select a node</h2></header>
      <div id="terminal" class="terminal" role="log"></div>
    </section>
    <div id="splitter-right" class="splitter" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="inspector" aria-label="Resize inspector rail" aria-valuemin="180" aria-valuemax="640" aria-valuenow="320"></div>
    <aside class="controls rail" id="inspector">
      <div class="rail-head">
        <button id="inspector-toggle" class="rail-toggle" type="button" aria-expanded="true" aria-controls="inspector-body" aria-label="Collapse inspector rail">&rsaquo;</button>
        <span class="rail-spine" aria-hidden="true">INSPECTOR</span>
        <span id="decision-badge" class="rail-badge" role="status" hidden></span>
      </div>
      <div class="rail-body" id="inspector-body">
      <section id="questions">
        <small>OPEN QUESTIONS <span id="question-count">0</span></small>
        <div id="question-list"></div>
      </section>
      <small>SELECTED NODE</small>
      <h2 id="selected-name">None</h2>
      <p id="selected-detail">Choose a graph node.</p>
      <section id="approval" hidden>
        <small>PHASE ARTIFACT</small>
        <dl id="artifact-identity">
          <div><dt>Path</dt><dd id="artifact-path">-</dd></div>
          <div><dt>Version</dt><dd id="artifact-version">-</dd></div>
          <div><dt>Digest</dt><dd id="artifact-digest">-</dd></div>
          <div><dt>Kind</dt><dd id="artifact-kind">-</dd></div>
          <div><dt>Created</dt><dd id="artifact-created">-</dd></div>
        </dl>
        <p id="artifact-declared"></p>
        <ul id="artifact-counts"></ul>
        <p><code id="artifact-command"></code></p>
        <div id="artifact-content" class="jsonview" aria-label="Artifact content"></div>
        <small>CONSUMED INPUTS</small>
        <div id="artifact-inputs" class="jsonview" aria-label="Consumed input manifest"></div>
        <div id="decision-controls" hidden>
          <textarea id="decision-note" placeholder="Decision note"></textarea>
          <div><button id="approve" class="run-command">Approve</button><button id="reject" class="danger run-command">Reject</button></div>
        </div>
      </section>
      <section id="steering" hidden>
        <textarea id="instruction" placeholder="Steering instruction"></textarea>
        <button id="steer" class="run-command">Send steer</button>
      </section>
      <section><button id="resume" class="run-command">Resume</button></section>
      <section id="ending">
        <textarea id="end-reason" placeholder="Reason required"></textarea>
        <button id="end" class="danger run-command">End run</button>
      </section>
      <p id="last-command" role="status" aria-live="polite">No browser command sent.</p>
      </div>
    </aside>
  </main>
</body>
</html>`;

export const stylesCss = `
:root{--ink:#18201d;--paper:#f4f5f1;--panel:#fff;--line:#d8ddd8;--green:#18794e;--blue:#1f5ea8;--amber:#9a6700;--red:#b4232f;--terminal:#131816}
*{box-sizing:border-box}
body{margin:0;min-width:320px;color:var(--ink);background-color:var(--paper);background-image:linear-gradient(rgba(24,32,29,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(24,32,29,.035) 1px,transparent 1px);background-size:24px 24px;font-family:"Trebuchet MS","Gill Sans",sans-serif;letter-spacing:0}
.topbar{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 20px;color:#fff;background:#1c2924;border-bottom:3px solid #d4a72c}
.topbar>div{display:flex;align-items:center;gap:12px}.topbar span{color:#bdc8c1}.topbar b{padding:5px 9px;color:#1c2924;background:#fff;border-radius:3px}
.workspace{min-height:calc(100vh - 56px);display:grid;grid-template-columns:var(--rail-left,220px) 6px minmax(320px,1fr) 6px var(--rail-right,320px)}
.workspace[data-left="collapsed"]{--rail-left:40px}
.workspace[data-right="collapsed"]{--rail-right:40px}
.overview,.controls{padding:24px 18px;background:rgba(255,255,255,.9)}.overview{border-right:1px solid var(--line)}.controls{border-left:1px solid var(--line)}.stage{min-width:0;padding:24px}
.rail{min-width:0;overflow:hidden}
.rail-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.rail-toggle{min-height:22px;margin:0;padding:1px 7px;color:#1c2924;background:transparent;border:1px solid var(--line);border-radius:3px;font:12px/1 monospace;font-weight:400}
.rail-spine{display:none;color:#67716d;font-size:10px;font-weight:700;letter-spacing:1px;writing-mode:vertical-rl}
.rail-badge{display:inline-block;padding:1px 7px;color:#fff;background:var(--amber);border-radius:9px;font-size:10px;font-weight:700}.rail-badge[hidden]{display:none}
.workspace[data-left="collapsed"] .overview,.workspace[data-right="collapsed"] .controls{padding:14px 5px}
.workspace[data-left="collapsed"] #overview-body,.workspace[data-right="collapsed"] #inspector-body{display:none}
.workspace[data-left="collapsed"] .overview .rail-head,.workspace[data-right="collapsed"] .controls .rail-head{flex-direction:column;gap:10px}
.workspace[data-left="collapsed"] .overview .rail-spine,.workspace[data-right="collapsed"] .controls .rail-spine{display:block}
.splitter{width:6px;background:var(--line);cursor:col-resize;touch-action:none}.splitter:hover,.splitter:focus-visible{background:var(--blue);outline:none}
html[data-dragging="true"]{cursor:col-resize;user-select:none}
small{color:#67716d;font-size:11px;font-weight:700}h1{font-size:23px}h2{font-size:17px}h1,h2{margin:6px 0 18px}
dl{margin-top:30px}dl div{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line)}dd{margin:0;font-family:monospace}
.graph{position:relative;width:100%;height:700px;min-height:480px;overflow:hidden;border:1px solid var(--line);border-radius:4px;background:rgba(255,255,255,.72)}
.terminal{height:430px;overflow:auto;padding:14px 16px;color:#d9e4dc;background:var(--terminal);border-radius:4px;font:12px/1.6 monospace;white-space:pre-wrap;word-break:break-word}
.line{display:grid;grid-template-columns:72px 52px minmax(0,1fr);gap:8px}.line .meta{color:#839089}.line.stderr .stream{color:#ff9aa4}
.controls section{margin-top:20px;padding-top:18px;border-top:1px solid var(--line)}textarea{width:100%;min-height:70px;padding:9px;resize:vertical}
button{min-height:36px;margin-top:8px;padding:8px 12px;color:#fff;background:var(--green);border:0;border-radius:4px;font-weight:700;cursor:pointer}.danger{background:var(--red)}button:disabled{cursor:wait;opacity:.55}#last-command.busy{color:var(--blue);font-weight:700}#last-command.busy::before{content:"";display:inline-block;width:8px;height:8px;margin-right:7px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
#questions{margin-top:0;padding-top:0;border-top:0}#questions small{display:flex;justify-content:space-between}#question-list:empty::after{content:"None";display:block;margin-top:8px;color:#67716d;font-size:12px}.question{padding:12px 0;border-bottom:1px solid var(--line)}.question p{margin:6px 0;font-size:13px;line-height:1.4;overflow-wrap:anywhere}.question textarea{min-height:56px;font:12px/1.4 monospace}.question button{width:100%}.question .question-status{color:#67716d;font-size:11px}.question.stale textarea,.question.stale button{cursor:not-allowed}
#artifact-identity{margin:10px 0}#artifact-identity div{display:block;padding:6px 0}#artifact-identity dd{margin-top:3px;overflow-wrap:anywhere;font-size:11px}#artifact-declared{font-size:13px;line-height:1.4}#artifact-counts{padding-left:18px;font:11px/1.5 monospace}#artifact-command{display:block;overflow-wrap:anywhere;font-size:11px}#decision-controls>div{display:grid;grid-template-columns:1fr 1fr;gap:8px}#steer,#resume,#end{width:100%}#last-command{color:#67716d;font:11px/1.5 monospace}
.jsonview{display:flex;flex-direction:column;gap:6px;margin:10px 0}
.jsonview-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.jsonview-toolbar input{flex:1 1 88px;min-width:0;padding:4px 6px;border:1px solid var(--line);border-radius:3px;font:11px/1.4 monospace}
.jsonview-toolbar button{min-height:22px;margin:0;padding:3px 7px;font-size:11px}
.jsonview-note,.jsonview-status{flex:1 1 100%;color:#67716d;font:10px/1.4 monospace}
.jsontree{max-height:360px;min-height:0;overflow:auto;margin:0;padding:8px;color:#d9e4dc;background:var(--terminal);border-radius:4px;font:11px/1.5 monospace;scrollbar-gutter:stable;list-style:none}
.jsontree ul{margin:0;padding-left:14px;list-style:none}
.jsonrow{display:flex;align-items:baseline;gap:4px;overflow-wrap:anywhere}.jsonrow.jmatch{background:rgba(246,193,119,.22);border-radius:2px}
.jtwisty{width:14px;min-height:14px;margin:0;padding:0;color:#9fb0a6;background:transparent;border:0;font:11px/1 monospace}.jtwisty:disabled{opacity:.35;cursor:default}
.jkey{color:#8fc7f0}.jstring{color:#c3e88d}.jnum{color:#f6c177}.jbool{color:#e5a3ff}.jnull{color:#9aa5a0}.jpunct{color:#7d8a84}.jpreview{color:#9aa5a0}
.jcopy{margin:0;padding:0 4px;color:#55635c;background:transparent;border:0;font:10px/1 monospace}.jsonrow:hover .jcopy,.jcopy:focus-visible{color:#d9e4dc}
.jsonmore,.jsonbudget{margin:0;padding:1px 6px;color:#8fc7f0;background:transparent;border:1px dashed #46524c;border-radius:3px;font:10px/1.5 monospace;font-weight:400}
.jsonbudget{display:inline-block;color:#f6c177}
.jsonraw{max-height:360px;overflow:auto;margin:0;padding:8px;color:#d9e4dc;background:var(--terminal);border-radius:4px;font:11px/1.45 monospace;white-space:pre-wrap;word-break:break-word}
@media(max-width:980px){.workspace{grid-template-columns:190px minmax(0,1fr)}.splitter{display:none}.controls{grid-column:1/-1;border-left:0;border-top:1px solid var(--line)}}
@media(max-width:680px){.workspace{display:block}.overview,.controls{border:0;border-bottom:1px solid var(--line)}.stage{padding:20px 12px}.graph{height:640px}.terminal{height:340px}}
`;

export const appJs = `
const q=(selector)=>document.querySelector(selector);
const runId=location.pathname.split("/").filter(Boolean)[1];
let state=null;
let selected=null;
let outputSource=null;
let workerSource=null;
let receiptSource=null;
let records=[];
let graph=null;
let commandPending=false;
let activeReceipt=null;
let openQuestions=[];
const questionDrafts=new Map();
const questionSubmissions=new Map();
const questionPending=new Set();
let pendingCommand=null;
let pendingPhaseId=null;
let receiptCursor=0;
let recordsRenderPending=false;
let approvalArtifact=null;
let approvalLoad=0;
let approvalKey=null;

const LAYOUT_KEY="senawa.console.layout.v1";
const RAIL_MIN=180;
const RAIL_MAX=640;
const RAIL_STEP=16;
const RAIL_LARGE_STEP=64;
const RAIL_LEFT_DEFAULT=220;
const RAIL_RIGHT_DEFAULT=320;
const layout={left:RAIL_LEFT_DEFAULT,right:RAIL_RIGHT_DEFAULT,leftCollapsed:false,rightCollapsed:false};
let dragState=null;
let layoutFramePending=false;
let graphFitPending=false;

const JSON_RAW_LIMIT=1000000;
const JSON_ROW_BUDGET=2000;
const JSON_CHUNK=100;
const JSON_STRING_CAP=512;
const JSON_DEFAULT_DEPTH=2;
const jsonNodeValues=new WeakMap();

cytoscape.use(cytoscapeDagre);

async function api(path,options={}){
  const response=await fetch(path,{credentials:"same-origin",headers:{"Content-Type":"application/json",...(options.headers||{})},...options});
  const body=await response.json();
  if(!response.ok){const error=new Error(body.error?.message||body.error||("HTTP "+response.status));error.code=body.error?.code;error.status=response.status;throw error}
  return body;
}

function text(tag,value,className){
  const node=document.createElement(tag);
  node.textContent=value;
  if(className)node.className=className;
  return node;
}

function clampRail(width){return Math.min(RAIL_MAX,Math.max(RAIL_MIN,Math.round(width)))}

function readLayout(){
  try{
    const stored=JSON.parse(localStorage.getItem(LAYOUT_KEY)||"null");
    if(stored===null||typeof stored!=="object")return;
    if(Number.isFinite(stored.left))layout.left=clampRail(stored.left);
    if(Number.isFinite(stored.right))layout.right=clampRail(stored.right);
    layout.leftCollapsed=stored.leftCollapsed===true;
    layout.rightCollapsed=stored.rightCollapsed===true;
  }catch{}
}

function saveLayout(){
  try{localStorage.setItem(LAYOUT_KEY,JSON.stringify(layout))}catch{}
}

function applyLayout(){
  const root=document.documentElement;
  root.style.setProperty("--rail-left",layout.left+"px");
  root.style.setProperty("--rail-right",layout.right+"px");
  const workspace=q("#workspace");
  workspace.dataset.left=layout.leftCollapsed?"collapsed":"expanded";
  workspace.dataset.right=layout.rightCollapsed?"collapsed":"expanded";
  applyRailToggle(q("#overview-toggle"),layout.leftCollapsed,"overview",layout.leftCollapsed?"›":"‹");
  applyRailToggle(q("#inspector-toggle"),layout.rightCollapsed,"inspector",layout.rightCollapsed?"‹":"›");
  q("#splitter-left").setAttribute("aria-valuenow",String(layout.leftCollapsed?RAIL_MIN:layout.left));
  q("#splitter-right").setAttribute("aria-valuenow",String(layout.rightCollapsed?RAIL_MIN:layout.right));
  scheduleGraphFit();
}

function applyRailToggle(toggle,collapsed,name,glyph){
  toggle.setAttribute("aria-expanded",String(!collapsed));
  toggle.setAttribute("aria-label",(collapsed?"Expand ":"Collapse ")+name+" rail");
  toggle.textContent=glyph;
}

function scheduleLayoutFrame(){
  if(layoutFramePending)return;
  layoutFramePending=true;
  requestAnimationFrame(()=>{layoutFramePending=false;applyLayout()});
}

function setRail(side,width){
  if(side==="left"){layout.left=clampRail(width);layout.leftCollapsed=false}
  else{layout.right=clampRail(width);layout.rightCollapsed=false}
  applyLayout();
  saveLayout();
}

function toggleRail(side,collapsed){
  const current=side==="left"?layout.leftCollapsed:layout.rightCollapsed;
  const next=collapsed===undefined?!current:collapsed;
  if(side==="left")layout.leftCollapsed=next;else layout.rightCollapsed=next;
  applyLayout();
  saveLayout();
}

function beginDrag(event,side){
  dragState={side,pointerId:event.pointerId,startX:event.clientX,startWidth:side==="left"?layout.left:layout.right};
  try{event.currentTarget.setPointerCapture(event.pointerId)}catch{}
  document.documentElement.dataset.dragging="true";
  event.preventDefault();
}

function moveDrag(event){
  if(dragState===null||event.pointerId!==dragState.pointerId)return;
  const delta=event.clientX-dragState.startX;
  const width=clampRail(dragState.startWidth+(dragState.side==="left"?delta:-delta));
  if(dragState.side==="left"){layout.left=width;layout.leftCollapsed=false}
  else{layout.right=width;layout.rightCollapsed=false}
  scheduleLayoutFrame();
}

function endDrag(event){
  if(dragState===null)return;
  try{event.currentTarget.releasePointerCapture(dragState.pointerId)}catch{}
  dragState=null;
  delete document.documentElement.dataset.dragging;
  applyLayout();
  saveLayout();
}

function splitterKeydown(event,side){
  const step=event.shiftKey?RAIL_LARGE_STEP:RAIL_STEP;
  const width=side==="left"?layout.left:layout.right;
  if(event.key==="ArrowLeft")setRail(side,width+(side==="left"?-step:step));
  else if(event.key==="ArrowRight")setRail(side,width+(side==="left"?step:-step));
  else if(event.key==="Home")setRail(side,RAIL_MIN);
  else if(event.key==="End")setRail(side,RAIL_MAX);
  else if(event.key==="Enter"||event.key===" ")toggleRail(side);
  else return;
  event.preventDefault();
}

function bindSplitter(selector,side){
  const splitter=q(selector);
  splitter.addEventListener("pointerdown",(event)=>beginDrag(event,side));
  splitter.addEventListener("pointermove",moveDrag);
  splitter.addEventListener("pointerup",endDrag);
  splitter.addEventListener("pointercancel",endDrag);
  splitter.addEventListener("lostpointercapture",endDrag);
  splitter.addEventListener("keydown",(event)=>splitterKeydown(event,side));
  splitter.addEventListener("dblclick",()=>setRail(side,side==="left"?RAIL_LEFT_DEFAULT:RAIL_RIGHT_DEFAULT));
}

function scheduleGraphFit(){
  if(graph===null||graphFitPending)return;
  graphFitPending=true;
  requestAnimationFrame(()=>{graphFitPending=false;graph?.resize();graph?.fit(undefined,32)});
}

function updateDecisionBadge(){
  const pending=state!==null&&state.phases.some((phase)=>phase.status==="awaiting_approval");
  const badge=q("#decision-badge");
  badge.textContent=pending?"!":"";
  badge.title=pending?"A phase decision is pending":"";
  badge.hidden=!pending;
}

function jsonKind(value){
  if(value===null)return "null";
  if(Array.isArray(value))return "array";
  return typeof value;
}

function jsonContainer(value){
  const kind=jsonKind(value);
  return kind==="array"||kind==="object";
}

function jsonEntries(value){
  return Array.isArray(value)?value.map((item,index)=>[String(index),item]):Object.entries(value);
}

function jsonPreview(value){
  if(Array.isArray(value))return value.length===1?"[1 item]":"["+value.length+" items]";
  const size=Object.keys(value).length;
  return size===1?"{1 key}":"{"+size+" keys}";
}

function jsonValueClass(value){
  const kind=jsonKind(value);
  if(kind==="string")return "jstring";
  if(kind==="number"||kind==="bigint")return "jnum";
  if(kind==="boolean")return "jbool";
  return "jnull";
}

function jsonText(value){
  return typeof value==="string"?value:String(value);
}

function jsonRow(view,key,value){
  const item=document.createElement("li");
  item.setAttribute("role","treeitem");
  const row=text("div","","jsonrow");
  const container=jsonContainer(value);
  const twisty=text("button",container?"▸":"·","jtwisty");
  twisty.type="button";
  twisty.disabled=!container;
  twisty.setAttribute("aria-hidden","true");
  twisty.tabIndex=-1;
  row.append(twisty);
  if(key!==null)row.append(text("span",key,"jkey"),text("span",":","jpunct"));
  let searchText=key===null?"":key;
  if(container){
    item.setAttribute("aria-expanded","false");
    row.append(text("span",jsonPreview(value),"jpreview"));
  }else{
    const raw=jsonText(value);
    const quoted=jsonKind(value)==="string";
    const shown=raw.length>JSON_STRING_CAP?raw.slice(0,JSON_STRING_CAP):raw;
    const valueNode=text("span",quoted?JSON.stringify(shown):shown,jsonValueClass(value));
    row.append(valueNode);
    if(raw.length>JSON_STRING_CAP){
      const more=text("button","… "+(raw.length-JSON_STRING_CAP)+" more characters","jsonmore");
      more.type="button";
      more.addEventListener("click",()=>{valueNode.textContent=quoted?JSON.stringify(raw):raw;more.remove()});
      row.append(more);
    }
    searchText+=" "+raw;
  }
  const copy=text("button","⧉","jcopy");
  copy.type="button";
  copy.setAttribute("aria-label","Copy "+(key===null?"payload":key));
  copy.addEventListener("click",()=>copyJson(view,value));
  row.append(copy);
  item.append(row);
  item.dataset.search=searchText.toLowerCase();
  jsonNodeValues.set(item,value);
  if(container){
    const group=document.createElement("ul");
    group.setAttribute("role","group");
    group.hidden=true;
    item.append(group);
    row.addEventListener("click",(event)=>{if(event.target===copy)return;toggleJsonNode(view,item)});
  }
  return item;
}

function appendJsonEntries(view,group,entries,start,end){
  for(let index=start;index<end;index+=1){
    if(view.rows>=JSON_ROW_BUDGET){
      group.append(text("li","Row budget of "+JSON_ROW_BUDGET+" rows reached; copy the payload to inspect the rest.","jsonbudget"));
      return;
    }
    view.rows+=1;
    group.append(jsonRow(view,entries[index][0],entries[index][1]));
  }
  if(end<entries.length){
    const holder=document.createElement("li");
    const next=text("button","Show next "+Math.min(JSON_CHUNK,entries.length-end)+" of "+entries.length,"jsonmore");
    next.type="button";
    next.addEventListener("click",()=>{holder.remove();appendJsonEntries(view,group,entries,end,Math.min(entries.length,end+JSON_CHUNK))});
    holder.append(next);
    group.append(holder);
  }
}

function buildJsonChildren(view,item){
  const group=item.lastElementChild;
  if(group.dataset.built==="true")return;
  group.dataset.built="true";
  const entries=jsonEntries(jsonNodeValues.get(item));
  appendJsonEntries(view,group,entries,0,Math.min(entries.length,JSON_CHUNK));
}

function toggleJsonNode(view,item,force){
  const expanded=force===undefined?item.getAttribute("aria-expanded")!=="true":force;
  if(expanded)buildJsonChildren(view,item);
  item.setAttribute("aria-expanded",String(expanded));
  item.lastElementChild.hidden=!expanded;
  const twisty=item.querySelector(".jtwisty");
  if(twisty!==null)twisty.textContent=expanded?"▾":"▸";
}

function expandJsonToDepth(view,scope,depth){
  if(depth<=0||view.rows>=JSON_ROW_BUDGET)return;
  for(const item of scope.children){
    if(item.tagName!=="LI"||!jsonContainer(jsonNodeValues.get(item)))continue;
    toggleJsonNode(view,item,true);
    expandJsonToDepth(view,item.lastElementChild,depth-1);
  }
}

function collapseJsonTree(view){
  for(const item of view.tree.querySelectorAll('[aria-expanded="true"]'))toggleJsonNode(view,item,false);
}

function applyJsonFilter(scope,needle){
  let total=0;
  for(const item of scope.children){
    if(item.tagName!=="LI")continue;
    const own=needle!==""&&(item.dataset.search||"").includes(needle);
    const row=item.firstElementChild;
    if(row!==null&&row.classList.contains("jsonrow"))row.classList.toggle("jmatch",own);
    const group=item.lastElementChild;
    const nested=group!==null&&group.tagName==="UL"?applyJsonFilter(group,needle):0;
    item.hidden=needle!==""&&!own&&nested===0;
    total+=(own?1:0)+nested;
  }
  return total;
}

function filterJson(view,query){
  const needle=query.trim().toLowerCase();
  if(needle!=="")expandJsonToDepth(view,view.tree,64);
  const matches=applyJsonFilter(view.tree,needle);
  view.status.textContent=needle===""?"":matches===1?"1 match":matches+" matches";
}

async function writeClipboard(payload){
  try{
    if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(payload);return true}
  }catch{}
  try{
    const holder=document.createElement("textarea");
    holder.value=payload;
    holder.setAttribute("aria-hidden","true");
    holder.style.position="fixed";
    holder.style.opacity="0";
    document.body.append(holder);
    holder.select();
    const copied=document.execCommand("copy");
    holder.remove();
    return copied;
  }catch{return false}
}

function copyJson(view,value){
  const payload=typeof value==="string"?value:JSON.stringify(value,null,2)??"undefined";
  void writeClipboard(payload).then((copied)=>{
    view.status.textContent=copied?"Copied "+payload.length+" characters":"Copy blocked; select the text instead";
  });
}

function renderJson(host,value,label){
  host.replaceChildren();
  const status=text("span","","jsonview-status");
  status.setAttribute("role","status");
  const toolbar=text("div","","jsonview-toolbar");
  const raw=JSON.stringify(value===undefined?null:value,null,2)??"null";
  const view={tree:null,status,rows:1,timer:null};
  const copyAll=text("button","Copy JSON","jsonview-copy");
  copyAll.type="button";
  copyAll.addEventListener("click",()=>copyJson(view,value));
  if(raw.length>JSON_RAW_LIMIT){
    toolbar.append(copyAll,text("span",label+" is "+Math.round(raw.length/1024)+" KB; showing bounded raw text.","jsonview-note"),status);
    host.append(toolbar,text("pre",raw.slice(0,JSON_RAW_LIMIT),"jsonraw"));
    return;
  }
  const tree=document.createElement("ul");
  tree.className="jsontree";
  tree.setAttribute("role","tree");
  tree.setAttribute("aria-label",label);
  view.tree=tree;
  const search=document.createElement("input");
  search.type="search";
  search.className="jsonview-search";
  search.placeholder="Filter";
  search.setAttribute("aria-label","Filter "+label);
  search.addEventListener("input",()=>{
    if(view.timer!==null)clearTimeout(view.timer);
    view.timer=setTimeout(()=>{view.timer=null;filterJson(view,search.value)},120);
  });
  const expand=text("button","Expand all","jsonview-expand");
  expand.type="button";
  expand.addEventListener("click",()=>{expandJsonToDepth(view,tree,64);filterJson(view,search.value)});
  const collapse=text("button","Collapse all","jsonview-collapse");
  collapse.type="button";
  collapse.addEventListener("click",()=>collapseJsonTree(view));
  toolbar.append(search,expand,collapse,copyAll,status);
  tree.append(jsonRow(view,null,value));
  host.append(toolbar,tree);
  expandJsonToDepth(view,tree,JSON_DEFAULT_DEPTH);
}

function nodes(){
  return [
    ...state.phases.map((phase)=>({kind:"phase",id:phase.id,label:phase.id,role:phase.role,status:phase.status,attempt:phase.iteration,dependsOn:phase.dependsOn||[]})),
    ...state.tasks.map((task)=>({kind:"task",id:task.key,label:task.title,role:task.role,status:task.status,attempt:task.attempt,parentPhaseId:task.parentPhaseId,dependsOn:task.dependsOn||[]})),
  ];
}

function displayLabel(label,role,status){
  return label+"\\n"+role+"\\n"+status.replaceAll("_"," ");
}

function graphElements(){
  const elements=[];
  const hasTasks=state.tasks.length>0;
  const taskFrontier=state.phases.find((phase)=>phase.executorKind==="task-frontier");
  const hasTaskFrontier=taskFrontier!==undefined;
  for(const phase of state.phases){
    elements.push({
      data:{id:"phase:"+phase.id,nodeId:phase.id,kind:"phase",label:displayLabel(phase.id,phase.role,phase.status),status:phase.status},
      classes:"phase status-"+phase.status+(phase.id===selected?" selected":""),
    });
    for(const dependency of phase.dependsOn||[]){
      if(hasTaskFrontier&&(phase.id===taskFrontier.id||dependency===taskFrontier.id))continue;
      elements.push({data:{id:"phase-edge:"+dependency+":"+phase.id,source:"phase:"+dependency,target:"phase:"+phase.id},classes:"phase-edge"});
    }
  }
  const dependedUpon=new Set(state.tasks.flatMap((task)=>task.dependsOn||[]));
  for(const task of state.tasks){
    elements.push({
      data:{id:"task:"+task.key,nodeId:task.key,kind:"task",label:displayLabel(task.title,task.role,task.status),status:task.status,parent:"phase:"+task.parentPhaseId},
      classes:"task status-"+task.status+(task.key===selected?" selected":""),
    });
    for(const dependency of task.dependsOn||[]){
      elements.push({data:{id:"task-edge:"+dependency+":"+task.key,source:"task:"+dependency,target:"task:"+task.key},classes:"task-edge"});
    }
  }
  if(hasTaskFrontier){
    const placeholderId="placeholder:"+taskFrontier.id+":tasks";
    const completionId="boundary:"+taskFrontier.id+":complete";
    for(const root of state.tasks.filter((task)=>task.parentPhaseId===taskFrontier.id&&(task.dependsOn||[]).length===0)){
      for(const dependency of taskFrontier.dependsOn||[]){
        elements.push({data:{id:"task-frontier-entry:"+taskFrontier.id+":"+dependency+":"+root.key,source:"phase:"+dependency,target:"task:"+root.key},classes:"phase-entry"});
      }
    }
    if(!hasTasks){
      elements.push({data:{id:placeholderId,nodeId:taskFrontier.id,kind:"placeholder",label:"Tasks from approved plan\\nnot expanded",status:"pending",parent:"phase:"+taskFrontier.id},classes:"implementation-placeholder status-pending"});
      for(const dependency of taskFrontier.dependsOn||[]){
        elements.push({data:{id:"task-frontier-entry:"+taskFrontier.id+":"+dependency+":placeholder",source:"phase:"+dependency,target:placeholderId},classes:"phase-entry"});
      }
    }
    elements.push({data:{id:completionId,nodeId:taskFrontier.id,kind:"boundary",label:"Implementation complete",status:taskFrontier.status||"pending",parent:"phase:"+taskFrontier.id},classes:"implementation-complete status-"+(taskFrontier.status||"pending")});
    const completionSources=hasTasks?state.tasks.filter((task)=>task.parentPhaseId===taskFrontier.id&&!dependedUpon.has(task.key)).map((task)=>"task:"+task.key):[placeholderId];
    for(const source of completionSources){
      elements.push({data:{id:"task-frontier-complete:"+taskFrontier.id+":"+source,source,target:completionId},classes:"task-edge completion-edge"});
    }
    for(const successor of state.phases.filter((phase)=>(phase.dependsOn||[]).includes(taskFrontier.id))){
      elements.push({data:{id:"task-frontier-exit:"+taskFrontier.id+":"+successor.id,source:completionId,target:"phase:"+successor.id},classes:"phase-edge verify-entry"});
    }
  }
  return elements;
}

const graphStyle=[
  {selector:"node",style:{label:"data(label)","font-family":"Trebuchet MS, Gill Sans, sans-serif","font-size":12,"font-weight":700,"text-wrap":"wrap","text-max-width":135,"text-valign":"center","text-halign":"center",color:"#18201d","background-color":"#fff","border-width":2,"border-color":"#98a29d",shape:"roundrectangle",width:160,height:78}},
  {selector:"node.task",style:{width:176,height:84,"font-size":11,"background-color":"#f8faf8"}},
  {selector:"node.implementation-placeholder",style:{width:176,height:72,"font-size":11,"font-style":"italic","background-color":"#f2f4f3","border-style":"dashed"}},
  {selector:"node.implementation-complete",style:{shape:"diamond",width:90,height:90,"font-size":10,"text-max-width":72,"background-color":"#e4eefb","border-color":"#1f5ea8"}},
  {selector:"node:parent",style:{"background-opacity":.08,"background-color":"#1f5ea8","border-width":2,"border-style":"dashed","border-color":"#1f5ea8",padding:40,"text-valign":"top","text-margin-y":-14,"font-size":13}},
  {selector:".status-running, .status-in_progress",style:{"border-color":"#1f5ea8","background-color":"#e4eefb"}},
  {selector:".status-awaiting_approval, .status-rework",style:{"border-color":"#9a6700","background-color":"#fff1c2"}},
  {selector:".status-accepted, .status-closed",style:{"border-color":"#18794e","background-color":"#dff3e8"}},
  {selector:".status-ended, .status-escalated",style:{"border-color":"#b4232f","background-color":"#fde7e9"}},
  {selector:".selected",style:{"border-width":4,"border-color":"#1f5ea8","overlay-opacity":.08,"overlay-color":"#1f5ea8"}},
  {selector:"edge",style:{width:2,"line-color":"#87928c","target-arrow-color":"#87928c","target-arrow-shape":"triangle","curve-style":"taxi","taxi-direction":"downward","taxi-turn":24}},
  {selector:"edge.task-edge",style:{"line-style":"dashed","line-color":"#1f5ea8","target-arrow-color":"#1f5ea8"}},
];

function calculatePositions(elements){
  const phaseElements=[];
  for(const phase of state.phases){
    phaseElements.push({data:{id:"phase:"+phase.id,label:phase.id},classes:"phase"});
    for(const dependency of phase.dependsOn||[]){phaseElements.push({data:{id:"layout-phase-edge:"+dependency+":"+phase.id,source:"phase:"+dependency,target:"phase:"+phase.id},classes:"phase-edge"})}
  }
  const phaseGraph=cytoscape({headless:true,styleEnabled:true,elements:phaseElements,style:graphStyle});
  phaseGraph.layout({name:"dagre",rankDir:"TB",rankSep:48,nodeSep:38,edgeSep:16,padding:32,animate:false}).run();
  const positions={};
  phaseGraph.nodes().forEach((node)=>{positions[node.id()]={...node.position()}});

  const taskElements=elements.filter((element)=>element.data.kind==="task"||element.data.kind==="boundary"||element.data.kind==="placeholder"||element.classes?.includes("task-edge")).map((element)=>{
    if(element.data.kind!=="task"&&element.data.kind!=="boundary"&&element.data.kind!=="placeholder")return element;
    const data={...element.data};
    delete data.parent;
    return {...element,data};
  });
  const taskFrontierPhase=state.phases.find((phase)=>phase.executorKind==="task-frontier");
  const taskFrontierPosition=taskFrontierPhase===undefined?undefined:positions["phase:"+taskFrontierPhase.id];
  if(taskElements.some((element)=>element.data.kind==="task"||element.data.kind==="placeholder")&&taskFrontierPosition){
    const taskGraph=cytoscape({headless:true,styleEnabled:true,elements:taskElements,style:graphStyle});
    taskGraph.layout({name:"dagre",rankDir:"TB",rankSep:38,nodeSep:30,edgeSep:12,padding:0,animate:false}).run();
    const taskBounds=taskGraph.nodes().boundingBox();
    const taskCenter={x:(taskBounds.x1+taskBounds.x2)/2,y:(taskBounds.y1+taskBounds.y2)/2};
    const expansion=Math.max(0,taskBounds.h+110-78);
    const taskGroupShift=expansion/2+40;
    taskGraph.nodes().forEach((node)=>{
      positions[node.id()]={x:taskFrontierPosition.x+node.position("x")-taskCenter.x,y:taskFrontierPosition.y+node.position("y")-taskCenter.y+taskGroupShift};
    });
    phaseGraph.nodes().forEach((node)=>{
      if(node.position("y")>taskFrontierPosition.y){positions[node.id()].y+=expansion}
    });
    taskGraph.destroy();
  }
  phaseGraph.destroy();
  return positions;
}

function renderGraph(){
  const elements=graphElements();
  const positions=calculatePositions(elements);
  if(graph===null){
    graph=cytoscape({container:q("#graph"),elements,style:graphStyle,layout:{name:"preset",positions:(node)=>positions[node.id()],padding:32,fit:true,animate:false}});
    globalThis.__senawaGraph=graph;
    graph.on("tap","node",(event)=>select(event.target.data("nodeId")));
  }else{
    graph.elements().remove();
    graph.add(elements);
    graph.layout({name:"preset",positions:(node)=>positions[node.id()],padding:32,fit:true,animate:false}).run();
  }
  graph.resize();
  graph.fit(undefined,32);
}

function render(){
  q("#workflow-name").textContent=state.workflow;
  q("#run-status").textContent=state.status.replaceAll("_"," ");
  q("#event-cursor").textContent=String(state.cursor);
  q("#phase-progress").textContent=state.progress.phases;
  const active=nodes().find((node)=>["running","in_progress","awaiting_approval"].includes(node.status));
  q("#active-phase").textContent=active?.id||"none";
  if(!selected)selected=active?.id||nodes()[0]?.id;
  renderGraph();
  const node=nodes().find((item)=>item.id===selected);
  q("#selected-name").textContent=node?.label||"None";
  q("#selected-detail").textContent=node?(node.role+" · "+node.status+" · attempt "+node.attempt):"Choose a graph node.";
  const phase=node?.kind==="phase"?state.phases.find((item)=>item.id===node.id):undefined;
  const artifactKey=phase?.artifactVersion==null?null:phase.id+":"+phase.artifactVersion;
  q("#approval").hidden=artifactKey===null;
  if(artifactKey!==approvalKey){
    approvalKey=artifactKey;
    approvalArtifact=null;
    if(artifactKey!==null)void renderApproval(phase.id);
  }
  updateDecision();
  q("#steering").hidden=node?.kind!=="task"||["closed","ended"].includes(node.status);
  q("#resume").hidden=["awaiting_approval","ended","finished"].includes(state.status);
  q("#ending").hidden=["ended","finished"].includes(state.status);
  updateDecisionBadge();
  renderQuestions();
  updateCommandProgress();
}

function updateDecision(){
  const node=nodes().find((item)=>item.id===selected);
  const decidable=node?.kind==="phase"&&node.status==="awaiting_approval"&&approvalArtifact!==null;
  if(decidable)q("#decision-controls").hidden=false;
  else q("#decision-controls").hidden=true;
  updateControlsLocked();
}

async function renderApproval(phaseId){
  const load=++approvalLoad;
  approvalArtifact=null;
  q("#decision-controls").hidden=true;
  q("#artifact-path").textContent="Loading";
  try{
    const brief=await api("/api/v1/runs/"+encodeURIComponent(runId)+"/phases/"+encodeURIComponent(phaseId)+"/brief");
    if(load!==approvalLoad||selected!==phaseId||brief.artifact===null)return;
    const overview=brief.artifact;
    const artifact=await api("/api/v1/runs/"+encodeURIComponent(runId)+"/phases/"+encodeURIComponent(phaseId)+"/artifacts/"+overview.version);
    if(load!==approvalLoad||selected!==phaseId)return;
    approvalArtifact=overview;
    q("#artifact-path").textContent=overview.path;
    q("#artifact-version").textContent=String(overview.version);
    q("#artifact-digest").textContent=overview.digest;
    q("#artifact-kind").textContent=overview.kind;
    q("#artifact-created").textContent=overview.createdAt;
    const declared=overview.declared.verdict??overview.declared.summary;
    const declaredKind=overview.declared.verdict?"verdict":"summary";
    q("#artifact-declared").textContent=declared?declared.attribution+" "+declaredKind+": "+declared.value:"No artifact-declared summary or verdict";
    q("#artifact-counts").replaceChildren(...overview.counts.map((count)=>text("li",count.name+": "+count.count)));
    q("#artifact-command").textContent=overview.fullArtifactCommand;
    renderJson(q("#artifact-content"),artifact.content,"Artifact content");
    renderJson(q("#artifact-inputs"),artifact.consumed,"Consumed inputs");
    updateDecision();
  }catch(error){if(load===approvalLoad)q("#artifact-path").textContent="Unavailable: "+error.message}
}

function renderQuestions(){
  q("#question-count").textContent=String(openQuestions.length);
  const list=q("#question-list");
  list.replaceChildren();
  for(const question of openQuestions){
    const form=text("form","","question "+question.status);
    const owner=text("small",question.ownerKind+" "+question.ownerId+" · "+new Date(question.askedAt).toLocaleTimeString([],{hour12:false}));
    const prompt=text("p",question.question);
    const answer=document.createElement("textarea");
    answer.maxLength=4000;
    answer.placeholder="Answer";
    answer.value=questionDrafts.get(question.questionId)||"";
    answer.addEventListener("input",()=>questionDrafts.set(question.questionId,answer.value));
    const button=text("button","Answer");
    button.type="submit";
    const status=text("p",question.status==="stale"?"No longer awaiting this answer":"","question-status");
    const locked=question.status!=="answerable"||questionPending.has(question.questionId);
    answer.disabled=locked;
    button.disabled=locked;
    form.addEventListener("submit",(event)=>{event.preventDefault();void submitAnswer(question,answer,button,status)});
    form.append(owner,prompt,answer,button,status);
    list.append(form);
  }
}

async function submitAnswer(question,answer,button,status){
  if(questionPending.has(question.questionId)||question.status!=="answerable")return;
  questionPending.add(question.questionId);
  answer.disabled=true;
  button.disabled=true;
  status.textContent="Submitting…";
  const submissionId=questionSubmissions.get(question.questionId)||crypto.randomUUID();
  questionSubmissions.set(question.questionId,submissionId);
  try{
    await api("/api/v1/runs/"+encodeURIComponent(runId)+"/questions/"+encodeURIComponent(question.questionId)+"/answer",{method:"POST",body:JSON.stringify({apiVersion:"senawa.dev/question-answer/v1",submissionId,answer:answer.value})});
    status.textContent="Answered";
    questionDrafts.delete(question.questionId);
    questionSubmissions.delete(question.questionId);
    await refresh();
  }catch(error){
    status.textContent=error.status===409?"No longer awaiting this answer":error.message;
    if(error.status===409)await refresh();
  }finally{
    questionPending.delete(question.questionId);
    const current=openQuestions.find((candidate)=>candidate.questionId===question.questionId);
    if(current?.status==="answerable"){answer.disabled=false;button.disabled=false}
  }
}

function updateCommandProgress(){
  if(activeReceipt===null||pendingCommand===null)return;
  if(activeReceipt.status==="queued"){q("#last-command").textContent=pendingCommand+" queued";return}
  if(activeReceipt.status==="refused"){q("#last-command").textContent="refused: "+activeReceipt.error.message;return}
  if(activeReceipt.status==="completed"){q("#last-command").textContent=pendingCommand+" completed";return}
  if(state===null){q("#last-command").textContent=pendingCommand+" in progress…";return}
  if(state.status==="finished"){q("#last-command").textContent="run finished";return}
  if(state.status==="ended"){q("#last-command").textContent="run ended";return}
  const decidedPhase=pendingPhaseId===null?null:state.phases.find((phase)=>phase.id===pendingPhaseId);
  if(decidedPhase?.status==="awaiting_approval"){
    q("#last-command").textContent=pendingCommand+" in progress…";
    return;
  }
  const activeTask=state.tasks.find((task)=>task.status==="in_progress"||task.status==="rework");
  const activePhase=state.phases.find((phase)=>phase.status==="running");
  if(activeTask){q("#last-command").textContent=activeTask.title+" · "+activeTask.status.replaceAll("_"," ")+"…";return}
  if(activePhase){q("#last-command").textContent=activePhase.id+" · "+activePhase.status.replaceAll("_"," ")+"…";return}
  if(state.needs?.phaseId){q("#last-command").textContent="awaiting "+state.needs.phaseId+" decision";return}
  q("#last-command").textContent=pendingCommand+" accepted; continuing…";
}

function renderRecords(){
  const terminal=q("#terminal");
  terminal.replaceChildren();
  for(const record of records){
    const row=text("div","","line "+record.stream);
    row.append(text("span",new Date(record.ts).toLocaleTimeString([],{hour12:false}),"meta"),text("span",record.stream,"stream"),text("span",record.text));
    terminal.append(row);
  }
  terminal.scrollTop=terminal.scrollHeight;
}

function scheduleRecordsRender(){
  if(recordsRenderPending)return;
  recordsRenderPending=true;
  requestAnimationFrame(()=>{recordsRenderPending=false;renderRecords()});
}

function appendWorkerRecord(record){
  const event=record.event;
  if(event.kind==="text"){
    const key="worker-text:"+event.turnId+":"+event.stream;
    const existing=records.find((item)=>item.key===key);
    if(existing){existing.text=event.delta?existing.text+event.text:event.text;existing.ts=event.ts}
    else{records.push({key,seq:record.seq,ts:event.ts,stream:event.stream,text:event.text})}
  }else if(event.kind==="tool"){
    records.push({key:"worker:"+event.eventId,seq:record.seq,ts:event.ts,stream:event.state==="failed"||event.state==="denied"?"stderr":"system",text:"tool "+event.name+" "+event.state+(event.detail?": "+event.detail:"")});
  }else if(event.kind==="lifecycle"){
    records.push({key:"worker:"+event.eventId,seq:record.seq,ts:event.ts,stream:event.event==="failed"?"stderr":"system",text:"worker "+event.event+(event.detail?": "+event.detail:"")});
  }else if(event.kind==="model"){
    records.push({key:"worker:"+event.eventId,seq:record.seq,ts:event.ts,stream:"system",text:"model "+event.resolved});
  }else if(event.kind==="usage"){
    records.push({key:"worker:"+event.eventId,seq:record.seq,ts:event.ts,stream:"system",text:"usage "+event.cumulativeNanoAiu+" nano AIU"});
  }
  scheduleRecordsRender();
}

function select(id){
  selected=id;
  outputSource?.close();
  workerSource?.close();
  records=[];
  render();
  renderRecords();
  q("#console-title").textContent=id+" output";
  const node=nodes().find((item)=>item.id===id);
  outputSource=new EventSource("/api/v1/runs/"+encodeURIComponent(runId)+"/streams/"+encodeURIComponent((node?.kind||"phase")+":"+id)+"/events");
  outputSource.onmessage=(event)=>{
    const record=JSON.parse(event.data);
    const key="output:"+record.seq;
    if(!records.some((item)=>item.key===key)){records.push({...record,key});scheduleRecordsRender()}
  };
  if(node?.kind==="phase"||node?.kind==="task"){
    workerSource=new EventSource("/api/v1/runs/"+encodeURIComponent(runId)+"/streams/"+encodeURIComponent(node.kind+":"+id)+"/worker-events");
    workerSource.onmessage=(event)=>appendWorkerRecord(JSON.parse(event.data));
  }
}

async function refresh(){
  const [snapshot,questions]=await Promise.all([
    api("/api/v1/runs/"+encodeURIComponent(runId)+"/snapshot"),
    api("/api/v1/runs/"+encodeURIComponent(runId)+"/questions/open"),
  ]);
  state=snapshot;
  openQuestions=questions.questions;
  render();
}
function receiptActive(){return activeReceipt!==null&&["queued","running"].includes(activeReceipt.status)}
function updateControlsLocked(){
  const locked=commandPending||receiptActive();
  q("#last-command").setAttribute("aria-busy",String(locked));
  for(const button of document.querySelectorAll(".run-command"))button.disabled=locked;
  q("#last-command").classList.toggle("busy",locked);
}
function setCommandPending(command,pending,extra={}){
  commandPending=pending;
  if(pending){pendingCommand=command;pendingPhaseId=typeof extra.phaseId==="string"?extra.phaseId:null}
  updateControlsLocked();
  if(pending)q("#last-command").textContent=command+" submitting…";
}
function applyReceipt(receipt){
  if(receipt.seq<=receiptCursor)return false;
  receiptCursor=receipt.seq;
  activeReceipt=receipt;
  pendingCommand=receipt.payload.command;
  pendingPhaseId=typeof receipt.payload.phaseId==="string"?receipt.payload.phaseId:null;
  updateControlsLocked();
  updateCommandProgress();
  return true;
}
function startReceiptStream(){
  receiptSource?.close();
  receiptSource=new EventSource("/api/v1/runs/"+encodeURIComponent(runId)+"/commands/events");
  receiptSource.onmessage=(event)=>{
    const receipt=JSON.parse(event.data);
    if(!applyReceipt(receipt))return;
    if(["completed","refused"].includes(receipt.status))void refresh();
  };
}
async function recoverActiveReceipt(){
  const response=await api("/api/v1/runs/"+encodeURIComponent(runId)+"/commands/active");
  if(response.receipt!==null)applyReceipt(response.receipt);
}
async function command(command,extra={}){
  if(commandPending)return;
  setCommandPending(command,true,extra);
  try{
    const response=await api("/api/v1/runs/"+encodeURIComponent(runId)+"/commands",{method:"POST",body:JSON.stringify({apiVersion:"senawa.dev/browser-command/v1",commandId:crypto.randomUUID(),command,...extra})});
    applyReceipt(response.receipt);
  }catch(error){q("#last-command").textContent="refused: "+error.message}
  finally{setCommandPending(command,false,extra)}
}

q("#approve").addEventListener("click",()=>approvalArtifact&&command("approve",{phaseId:selected,expectedVersion:approvalArtifact.version,expectedDigest:approvalArtifact.digest,note:q("#decision-note").value||undefined}));
q("#reject").addEventListener("click",()=>approvalArtifact&&command("reject",{phaseId:selected,expectedVersion:approvalArtifact.version,expectedDigest:approvalArtifact.digest,reason:q("#decision-note").value}));
q("#steer").addEventListener("click",()=>command("steer",{taskId:selected,instruction:q("#instruction").value}));
q("#resume").addEventListener("click",()=>command("resume"));
q("#end").addEventListener("click",()=>command("end",{reason:q("#end-reason").value}));
bindSplitter("#splitter-left","left");
bindSplitter("#splitter-right","right");
q("#overview-toggle").addEventListener("click",()=>toggleRail("left"));
q("#inspector-toggle").addEventListener("click",()=>toggleRail("right"));
readLayout();
applyLayout();
if(typeof ResizeObserver==="function")new ResizeObserver(()=>{if(dragState===null)scheduleGraphFit()}).observe(q("#graph"));
addEventListener("resize",()=>{graph?.resize();graph?.fit(undefined,32)});

Promise.all([refresh(),recoverActiveReceipt()]).then(()=>{select(selected);startReceiptStream();const events=new EventSource("/api/v1/runs/"+encodeURIComponent(runId)+"/events/stream");events.onopen=()=>q("#connection").textContent="Live";events.onmessage=refresh;events.onerror=()=>q("#connection").textContent="Reconnecting"}).catch((error)=>q("#connection").textContent=error.message);
`;

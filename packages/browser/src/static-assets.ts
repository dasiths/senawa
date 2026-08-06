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
  <main class="workspace">
    <aside class="overview">
      <small>ACTIVE WORKFLOW</small>
      <h1 id="workflow-name">Loading run</h1>
      <dl>
        <div><dt>Phases</dt><dd id="phase-progress">-</dd></div>
        <div><dt>Active</dt><dd id="active-phase">-</dd></div>
        <div><dt>Cursor</dt><dd id="event-cursor">0</dd></div>
      </dl>
    </aside>
    <section class="stage">
      <header><small>WORKFLOW GRAPH</small><h2>Execution path</h2></header>
      <div id="graph" class="graph" aria-label="Workflow dependency graph"></div>
      <hr>
      <header><small>AGENT OUTPUT</small><h2 id="console-title">Select a node</h2></header>
      <div id="terminal" class="terminal" role="log"></div>
    </section>
    <aside class="controls">
      <small>SELECTED NODE</small>
      <h2 id="selected-name">None</h2>
      <p id="selected-detail">Choose a graph node.</p>
      <section id="approval" hidden>
        <textarea id="decision-note" placeholder="Decision note"></textarea>
        <div><button id="approve">Approve</button><button id="reject" class="danger">Reject</button></div>
      </section>
      <section id="steering" hidden>
        <textarea id="instruction" placeholder="Steering instruction"></textarea>
        <button id="steer">Send steer</button>
      </section>
      <section><button id="resume">Resume</button></section>
      <section id="ending">
        <textarea id="end-reason" placeholder="Reason required"></textarea>
        <button id="end" class="danger">End run</button>
      </section>
      <p id="last-command" role="status" aria-live="polite">No browser command sent.</p>
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
.workspace{min-height:calc(100vh - 56px);display:grid;grid-template-columns:220px minmax(520px,1fr)260px}
.overview,.controls{padding:24px 18px;background:rgba(255,255,255,.9)}.overview{border-right:1px solid var(--line)}.controls{border-left:1px solid var(--line)}.stage{min-width:0;padding:24px}
small{color:#67716d;font-size:11px;font-weight:700}h1{font-size:23px}h2{font-size:17px}h1,h2{margin:6px 0 18px}
dl{margin-top:30px}dl div{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line)}dd{margin:0;font-family:monospace}
.graph{position:relative;width:100%;height:700px;min-height:480px;overflow:hidden;border:1px solid var(--line);border-radius:4px;background:rgba(255,255,255,.72)}
.terminal{height:430px;overflow:auto;padding:14px 16px;color:#d9e4dc;background:var(--terminal);border-radius:4px;font:12px/1.6 monospace;white-space:pre-wrap;word-break:break-word}
.line{display:grid;grid-template-columns:72px 52px minmax(0,1fr);gap:8px}.line .meta{color:#839089}.line.stderr .stream{color:#ff9aa4}
.controls section{margin-top:20px;padding-top:18px;border-top:1px solid var(--line)}textarea{width:100%;min-height:70px;padding:9px;resize:vertical}
button{min-height:36px;margin-top:8px;padding:8px 12px;color:#fff;background:var(--green);border:0;border-radius:4px;font-weight:700;cursor:pointer}.danger{background:var(--red)}button:disabled{cursor:wait;opacity:.55}#last-command.busy{color:var(--blue);font-weight:700}#last-command.busy::before{content:"";display:inline-block;width:8px;height:8px;margin-right:7px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
#approval div{display:grid;grid-template-columns:1fr 1fr;gap:8px}#steer,#resume,#end{width:100%}#last-command{color:#67716d;font:11px/1.5 monospace}
@media(max-width:980px){.workspace{grid-template-columns:190px minmax(0,1fr)}.controls{grid-column:1/-1;border-left:0;border-top:1px solid var(--line)}}
@media(max-width:680px){.workspace{display:block}.overview,.controls{border:0;border-bottom:1px solid var(--line)}.stage{padding:20px 12px}.graph{height:640px}.terminal{height:340px}}
`;

export const appJs = `
const q=(selector)=>document.querySelector(selector);
const runId=location.pathname.split("/").filter(Boolean)[1];
let state=null;
let selected=null;
let outputSource=null;
let workerSource=null;
let records=[];
let graph=null;
let commandPending=false;
let activeReceipt=null;
let pendingCommand=null;
let pendingPhaseId=null;
let receiptPoll=null;
let recordsRenderPending=false;

cytoscape.use(cytoscapeDagre);

async function api(path,options={}){
  const response=await fetch(path,{credentials:"same-origin",headers:{"Content-Type":"application/json",...(options.headers||{})},...options});
  const body=await response.json();
  if(!response.ok)throw new Error(body.error?.message||body.error||("HTTP "+response.status));
  return body;
}

function text(tag,value,className){
  const node=document.createElement(tag);
  node.textContent=value;
  if(className)node.className=className;
  return node;
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
  q("#approval").hidden=node?.kind!=="phase"||node.status!=="awaiting_approval";
  q("#steering").hidden=node?.kind!=="task"||["closed","ended"].includes(node.status);
  q("#resume").hidden=["awaiting_approval","ended","finished"].includes(state.status);
  q("#ending").hidden=["ended","finished"].includes(state.status);
  updateCommandProgress();
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

async function refresh(){state=await api("/api/v1/runs/"+encodeURIComponent(runId)+"/snapshot");render()}
function receiptActive(){return activeReceipt!==null&&["queued","running"].includes(activeReceipt.status)}
function updateControlsLocked(){
  const locked=commandPending||receiptActive();
  q(".controls").setAttribute("aria-busy",String(locked));
  for(const button of document.querySelectorAll(".controls button"))button.disabled=locked;
  q("#last-command").classList.toggle("busy",locked);
}
function setCommandPending(command,pending,extra={}){
  commandPending=pending;
  if(pending){pendingCommand=command;pendingPhaseId=typeof extra.phaseId==="string"?extra.phaseId:null}
  updateControlsLocked();
  if(pending)q("#last-command").textContent=command+" submitting…";
}
function applyReceipt(receipt){
  activeReceipt=receipt;
  pendingCommand=receipt.payload.command;
  pendingPhaseId=typeof receipt.payload.phaseId==="string"?receipt.payload.phaseId:null;
  updateControlsLocked();
  updateCommandProgress();
}
async function pollReceipt(){
  if(activeReceipt===null)return;
  clearTimeout(receiptPoll);
  try{
    const response=await api("/api/v1/runs/"+encodeURIComponent(runId)+"/commands/"+encodeURIComponent(activeReceipt.commandId));
    applyReceipt(response.receipt);
    if(["queued","running"].includes(response.receipt.status)){receiptPoll=setTimeout(pollReceipt,250);return}
    await refresh();
  }catch(error){
    q("#last-command").textContent="receipt unavailable: "+error.message;
    receiptPoll=setTimeout(pollReceipt,1000);
  }
}
async function recoverActiveReceipt(){
  const response=await api("/api/v1/runs/"+encodeURIComponent(runId)+"/commands/active");
  if(response.receipt!==null){applyReceipt(response.receipt);void pollReceipt()}
}
async function command(command,extra={}){
  if(commandPending)return;
  setCommandPending(command,true,extra);
  try{
    const response=await api("/api/v1/runs/"+encodeURIComponent(runId)+"/commands",{method:"POST",body:JSON.stringify({apiVersion:"senawa.dev/browser-command/v1",commandId:crypto.randomUUID(),command,...extra})});
    applyReceipt(response.receipt);
    void pollReceipt();
  }catch(error){q("#last-command").textContent="refused: "+error.message}
  finally{setCommandPending(command,false,extra)}
}

q("#approve").addEventListener("click",()=>command("approve",{phaseId:selected,note:q("#decision-note").value||undefined}));
q("#reject").addEventListener("click",()=>command("reject",{phaseId:selected,reason:q("#decision-note").value}));
q("#steer").addEventListener("click",()=>command("steer",{taskId:selected,instruction:q("#instruction").value}));
q("#resume").addEventListener("click",()=>command("resume"));
q("#end").addEventListener("click",()=>command("end",{reason:q("#end-reason").value}));
addEventListener("resize",()=>{graph?.resize();graph?.fit(undefined,32)});

Promise.all([refresh(),recoverActiveReceipt()]).then(()=>{select(selected);const events=new EventSource("/api/v1/runs/"+encodeURIComponent(runId)+"/events/stream");events.onopen=()=>q("#connection").textContent="Live";events.onmessage=refresh;events.onerror=()=>q("#connection").textContent="Reconnecting"}).catch((error)=>q("#connection").textContent=error.message);
`;

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
      <p id="last-command">No browser command sent.</p>
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
button{min-height:36px;margin-top:8px;padding:8px 12px;color:#fff;background:var(--green);border:0;border-radius:4px;font-weight:700;cursor:pointer}.danger{background:var(--red)}
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
let records=[];
let graph=null;

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
  for(const phase of state.phases){
    elements.push({
      data:{id:"phase:"+phase.id,nodeId:phase.id,kind:"phase",label:displayLabel(phase.id,phase.role,phase.status),status:phase.status},
      classes:"phase status-"+phase.status+(phase.id===selected?" selected":""),
    });
    for(const dependency of phase.dependsOn||[]){
      if(hasTasks&&(phase.id==="implement"||(phase.id==="verify"&&dependency==="implement")))continue;
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
  if(hasTasks){
    const implementation=state.phases.find((phase)=>phase.id==="implement");
    for(const root of state.tasks.filter((task)=>(task.dependsOn||[]).length===0)){
      for(const dependency of implementation?.dependsOn||[]){
        elements.push({data:{id:"implementation-entry:"+dependency+":"+root.key,source:"phase:"+dependency,target:"task:"+root.key},classes:"phase-entry"});
      }
    }
    elements.push({data:{id:"boundary:implementation-complete",nodeId:"implement",kind:"boundary",label:"Implementation complete",status:implementation?.status||"pending",parent:"phase:implement"},classes:"implementation-complete status-"+(implementation?.status||"pending")});
    for(const leaf of state.tasks.filter((task)=>!dependedUpon.has(task.key))){
      elements.push({data:{id:"implementation-complete:"+leaf.key,source:"task:"+leaf.key,target:"boundary:implementation-complete"},classes:"task-edge completion-edge"});
    }
    elements.push({data:{id:"verify-entry",source:"boundary:implementation-complete",target:"phase:verify"},classes:"phase-edge verify-entry"});
  }
  return elements;
}

const graphStyle=[
  {selector:"node",style:{label:"data(label)","font-family":"Trebuchet MS, Gill Sans, sans-serif","font-size":12,"font-weight":700,"text-wrap":"wrap","text-max-width":135,"text-valign":"center","text-halign":"center",color:"#18201d","background-color":"#fff","border-width":2,"border-color":"#98a29d",shape:"roundrectangle",width:160,height:78}},
  {selector:"node.task",style:{width:176,height:84,"font-size":11,"background-color":"#f8faf8"}},
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

  const taskElements=elements.filter((element)=>element.data.kind==="task"||element.data.kind==="boundary"||element.classes?.includes("task-edge")).map((element)=>{
    if(element.data.kind!=="task"&&element.data.kind!=="boundary")return element;
    const data={...element.data};
    delete data.parent;
    return {...element,data};
  });
  const implementPosition=positions["phase:implement"];
  if(taskElements.some((element)=>element.data.kind==="task")&&implementPosition){
    const taskGraph=cytoscape({headless:true,styleEnabled:true,elements:taskElements,style:graphStyle});
    taskGraph.layout({name:"dagre",rankDir:"TB",rankSep:38,nodeSep:30,edgeSep:12,padding:0,animate:false}).run();
    const taskBounds=taskGraph.nodes().boundingBox();
    const taskCenter={x:(taskBounds.x1+taskBounds.x2)/2,y:(taskBounds.y1+taskBounds.y2)/2};
    const expansion=Math.max(0,taskBounds.h+110-78);
    const taskGroupShift=expansion/2+40;
    taskGraph.nodes().forEach((node)=>{
      positions[node.id()]={x:implementPosition.x+node.position("x")-taskCenter.x,y:implementPosition.y+node.position("y")-taskCenter.y+taskGroupShift};
    });
    phaseGraph.nodes().forEach((node)=>{
      if(node.position("y")>implementPosition.y){positions[node.id()].y+=expansion}
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

function select(id){
  selected=id;
  outputSource?.close();
  records=[];
  render();
  renderRecords();
  q("#console-title").textContent=id+" output";
  const node=nodes().find((item)=>item.id===id);
  outputSource=new EventSource("/api/v1/runs/"+encodeURIComponent(runId)+"/streams/"+encodeURIComponent((node?.kind||"phase")+":"+id)+"/events");
  outputSource.onmessage=(event)=>{
    const record=JSON.parse(event.data);
    if(!records.some((item)=>item.seq===record.seq)){records.push(record);renderRecords()}
  };
}

async function refresh(){state=await api("/api/v1/runs/"+encodeURIComponent(runId)+"/snapshot");render()}
async function command(command,extra={}){try{await api("/api/v1/runs/"+encodeURIComponent(runId)+"/commands",{method:"POST",body:JSON.stringify({apiVersion:"senawa.dev/browser-command/v1",command,...extra})});q("#last-command").textContent=command+" accepted";await refresh()}catch(error){q("#last-command").textContent="refused: "+error.message}}

q("#approve").addEventListener("click",()=>command("approve",{phaseId:selected,note:q("#decision-note").value||undefined}));
q("#reject").addEventListener("click",()=>command("reject",{phaseId:selected,reason:q("#decision-note").value}));
q("#steer").addEventListener("click",()=>command("steer",{taskId:selected,instruction:q("#instruction").value}));
q("#resume").addEventListener("click",()=>command("resume"));
q("#end").addEventListener("click",()=>command("end",{reason:q("#end-reason").value}));
addEventListener("resize",()=>{graph?.resize();graph?.fit(undefined,32)});

refresh().then(()=>{select(selected);const events=new EventSource("/api/v1/runs/"+encodeURIComponent(runId)+"/events/stream");events.onopen=()=>q("#connection").textContent="Live";events.onmessage=refresh;events.onerror=()=>q("#connection").textContent="Reconnecting"}).catch((error)=>q("#connection").textContent=error.message);
`;

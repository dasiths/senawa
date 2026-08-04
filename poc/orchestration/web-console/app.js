const $ = (selector) => document.querySelector(selector);

let snapshot = null;
let selectedPhase = null;
let outputSource = null;
let outputRecords = [];

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

function phaseLabel(status) {
  return status.replaceAll("_", " ");
}

function renderGraph() {
  const graph = $("#graph");
  graph.replaceChildren();
  snapshot.phases.forEach((phase, index) => {
    if (index > 0) {
      const edge = document.createElement("div");
      edge.className = "graph-edge";
      edge.setAttribute("aria-hidden", "true");
      graph.append(edge);
    }
    const node = document.createElement("button");
    node.type = "button";
    node.className = `phase-node ${phase.status}${phase.id === selectedPhase ? " selected" : ""}`;
    node.dataset.phase = phase.id;
    node.innerHTML = `
      <span class="phase-title">${phase.id}</span>
      <span class="phase-role">${phase.role}</span>
      <span class="phase-status">${phaseLabel(phase.status)}</span>
    `;
    node.addEventListener("click", () => selectPhase(phase.id));
    graph.append(node);
  });
}

function renderControls() {
  const phase = snapshot.phases.find((item) => item.id === selectedPhase);
  $("#selected-name").textContent = phase ? phase.id : "None";
  $("#selected-detail").textContent = phase
    ? `${phase.role} · ${phaseLabel(phase.status)} · attempt ${phase.attempt}`
    : "Choose a graph node to inspect its session.";
  $("#approval-controls").hidden = phase?.status !== "awaiting_approval";
  $("#steer-controls").hidden = phase?.status !== "running";
}

function renderSnapshot() {
  $("#workflow-name").textContent = snapshot.workflow;
  $("#run-status").textContent = phaseLabel(snapshot.status);
  $("#event-cursor").textContent = String(snapshot.cursor);
  const accepted = snapshot.phases.filter((phase) => phase.status === "accepted").length;
  $("#phase-progress").textContent = `${accepted}/${snapshot.phases.length}`;
  const active = snapshot.phases.find((phase) => ["running", "awaiting_approval"].includes(phase.status));
  $("#active-phase").textContent = active?.id ?? "none";
  $("#needs-human").hidden = snapshot.status !== "awaiting_approval";
  if (!selectedPhase || !snapshot.phases.some((phase) => phase.id === selectedPhase)) {
    selectedPhase = active?.id ?? snapshot.phases[0]?.id;
  }
  renderGraph();
  renderControls();
}

function outputLine(record) {
  const row = document.createElement("div");
  row.className = `output-line ${record.stream}`;
  const time = new Date(record.at).toLocaleTimeString([], { hour12: false });
  row.innerHTML = `<span class="time">${time}</span><span class="stream">${record.stream}</span><span class="text"></span>`;
  row.querySelector(".text").textContent = record.text;
  return row;
}

function renderOutput() {
  const terminal = $("#terminal");
  terminal.replaceChildren();
  if (!outputRecords.length) {
    const empty = document.createElement("div");
    empty.className = "empty-output";
    empty.textContent = "Waiting for session output...";
    terminal.append(empty);
  } else {
    for (const record of outputRecords) terminal.append(outputLine(record));
    terminal.scrollTop = terminal.scrollHeight;
  }
  $("#line-count").textContent = `${outputRecords.length} records`;
}

function connectOutput(phaseId) {
  outputSource?.close();
  outputRecords = [];
  renderOutput();
  $("#stream-state").textContent = "Connecting";
  outputSource = new EventSource(`/api/phases/${phaseId}/output`);
  outputSource.onopen = () => { $("#stream-state").textContent = "Live + replay"; };
  outputSource.onmessage = (event) => {
    const record = JSON.parse(event.data);
    if (!outputRecords.some((item) => item.seq === record.seq)) {
      outputRecords.push(record);
      const terminal = $("#terminal");
      terminal.querySelector(".empty-output")?.remove();
      terminal.append(outputLine(record));
      terminal.scrollTop = terminal.scrollHeight;
      $("#line-count").textContent = `${outputRecords.length} records`;
    }
  };
  outputSource.onerror = () => { $("#stream-state").textContent = "Reconnecting"; };
}

function selectPhase(phaseId) {
  selectedPhase = phaseId;
  renderGraph();
  renderControls();
  $("#console-title").textContent = `${phaseId} session`;
  connectOutput(phaseId);
}

async function refreshSnapshot() {
  snapshot = await api("/api/snapshot");
  renderSnapshot();
}

async function sendCommand(command, extra = {}) {
  const buttonIds = ["#approve", "#reject", "#steer"];
  buttonIds.forEach((id) => { $(id).disabled = true; });
  try {
    await api("/api/commands", {
      method: "POST",
      body: JSON.stringify({ command, phase: selectedPhase, ...extra }),
    });
    $("#last-command").textContent = `${command} ${selectedPhase} accepted by server`;
    $("#reject-reason").value = "";
    $("#steer-instruction").value = "";
    await refreshSnapshot();
  } catch (error) {
    $("#last-command").textContent = `refused: ${error.message}`;
  } finally {
    buttonIds.forEach((id) => { $(id).disabled = false; });
  }
}

$("#approve").addEventListener("click", () => sendCommand("approve"));
$("#reject").addEventListener("click", () => sendCommand("reject", { reason: $("#reject-reason").value }));
$("#steer").addEventListener("click", () => sendCommand("steer", { instruction: $("#steer-instruction").value }));

async function start() {
  await refreshSnapshot();
  const active = snapshot.phases.find((phase) => ["running", "awaiting_approval"].includes(phase.status));
  selectPhase(active?.id ?? snapshot.phases[0].id);
  const events = new EventSource("/api/events");
  events.onopen = () => {
    $("#connection").textContent = "Live";
    $("#connection").classList.add("live");
  };
  events.onmessage = async () => { await refreshSnapshot(); };
  events.onerror = () => {
    $("#connection").textContent = "Reconnecting";
    $("#connection").classList.remove("live");
  };
}

start().catch((error) => {
  $("#connection").textContent = error.message;
});

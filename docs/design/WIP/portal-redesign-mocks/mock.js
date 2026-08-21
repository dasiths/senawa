// Mock interactions only: selection, tab switching, and lazy row expansion with
// an artificial delay so the loading state is visible.

function activate(group, target) {
  for (const button of document.querySelectorAll(`[data-group="${group}"]`)) {
    const selected = button === target;
    button.setAttribute("aria-selected", String(selected));
    const pane = document.getElementById(button.dataset.pane);
    if (pane !== null) pane.hidden = !selected;
  }
}

document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-group]");
  if (tab !== null) {
    activate(tab.dataset.group, tab);
    if (tab.dataset.group === "w") showGraph(tab.dataset.pane === "w-graph");
    return;
  }

  const node = event.target.closest("[data-selects]");
  if (node !== null) {
    for (const other of document.querySelectorAll("[data-selects]")) {
      other.setAttribute("aria-current", String(other === node));
    }
    showSelection(node.dataset.selects);
    return;
  }

  const row = event.target.closest("tr[data-record]");
  if (row !== null) expandRow(row);
});

// Detail is fetched when a row is opened, never up front. The delay is here so
// the mock shows what that costs a reader: one beat, once, on the row they
// asked about.
function expandRow(row) {
  const open = row.getAttribute("aria-expanded") === "true";
  const next = row.nextElementSibling;
  if (open) {
    row.setAttribute("aria-expanded", "false");
    if (next?.classList.contains("detail-row")) next.remove();
    return;
  }
  row.setAttribute("aria-expanded", "true");
  const holder = document.createElement("tr");
  holder.className = "detail-row";
  const cell = document.createElement("td");
  cell.colSpan = row.children.length;
  cell.innerHTML = '<p class="lazy">Loading the exact record…</p>';
  holder.append(cell);
  row.after(holder);
  setTimeout(() => {
    cell.innerHTML = `<pre class="record">${row.dataset.record}</pre>`;
  }, 320);
}

function showSelection(key) {
  const source = document.getElementById(`selection-${key}`);
  const target = document.getElementById("selection");
  if (source === null || target === null) return;
  target.innerHTML = source.innerHTML;
  const first = target.querySelector("[data-group]");
  if (first !== null) activate(first.dataset.group, first);
}

const initial = document.querySelector("[data-selects][aria-current='true']");
if (initial !== null) showSelection(initial.dataset.selects);

// The graph is the same workflow read as dependencies rather than containment,
// so it needs the column width the tree does not.
function showGraph(wide) {
  document.querySelector(".split")?.classList.toggle("is-wide", wide);
  if (wide) drawEdges();
}

// Edges are measured from the laid-out nodes rather than authored as
// coordinates, so the picture survives wrapping, resizing and renaming.
function drawEdges() {
  const graph = document.getElementById("graph");
  const svg = graph?.querySelector(".graph-edges");
  if (svg == null || graph.offsetParent === null) return;

  const box = graph.getBoundingClientRect();
  const paths = [];
  for (const target of graph.querySelectorAll("[data-from]")) {
    const to = target.getBoundingClientRect();
    for (const entry of target.dataset.from.split(",")) {
      const [id, flow] = entry.trim().split(/\s+/);
      const source = graph.querySelector(`[data-node="${id}"]`);
      if (source === null) continue;
      const from = anchor(source).getBoundingClientRect();
      const x1 = from.left - box.left + from.width / 2;
      const y1 = from.bottom - box.top;
      const x2 = to.left - box.left + to.width / 2;
      const y2 = to.top - box.top;
      const bend = Math.max(14, (y2 - y1) * 0.55);
      paths.push(
        `<path class="edge${flow === "done" ? " is-done" : ""}" marker-end="url(#tip${flow === "done" ? "-done" : ""})" d="M${x1} ${y1} C${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2 - 5}" />`,
      );
    }
  }
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  svg.innerHTML = `<defs>${arrow("tip", "#cfd4dc")}${arrow("tip-done", "#b6c2d2")}</defs>${paths.join("")}`;
}

function arrow(id, fill) {
  return `<marker id="${id}" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L8 4 L0 8 z" fill="${fill}" /></marker>`;
}

// Folding a phase away must not delete its edges: they attach to the group that
// swallowed the node instead.
function anchor(node) {
  let at = node;
  while (at.offsetWidth === 0 && at.parentElement !== null) {
    at = at.parentElement.closest("[data-node]") ?? at.parentElement;
  }
  return at;
}

document.addEventListener("toggle", (event) => {
  if (event.target.classList.contains("band")) drawEdges();
}, true);

new ResizeObserver(() => drawEdges()).observe(document.body);

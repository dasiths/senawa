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

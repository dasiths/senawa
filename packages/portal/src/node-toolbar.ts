export interface NodeToolbarAction {
  readonly key: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly run: () => void;
}

export interface NodeToolbarInput {
  readonly nodeId: string;
  readonly actions: readonly NodeToolbarAction[];
}

/** Index math for the roving tab stop; `undefined` means the key does not move focus. */
export function nextRovingIndex(current: number, key: string, count: number): number | undefined {
  if (count <= 0 || current < 0 || current >= count) return undefined;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  return undefined;
}

export function firstRovingIndex(disabled: readonly boolean[]): number {
  const index = disabled.indexOf(false);
  return index < 0 ? 0 : index;
}

export function nodeToolbarView(input: NodeToolbarInput): HTMLElement {
  const toolbar = document.createElement("div");
  toolbar.className = "node-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Selected node actions");
  toolbar.setAttribute("aria-orientation", "horizontal");
  const buttons = input.actions.map((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "command toolbar-button";
    button.textContent = action.label;
    button.disabled = action.disabled;
    button.tabIndex = -1;
    button.dataset.focusKey = `node-toolbar:${input.nodeId}:${action.key}`;
    button.dataset.toolbarKey = action.key;
    button.addEventListener("click", action.run);
    return button;
  });
  const active = firstRovingIndex(buttons.map(({ disabled }) => disabled));
  const first = buttons[active];
  if (first !== undefined) first.tabIndex = 0;
  toolbar.addEventListener("keydown", (event) => {
    const enabled = buttons.filter(({ disabled }) => !disabled);
    const active = document.activeElement;
    const index = active instanceof HTMLButtonElement ? enabled.indexOf(active) : -1;
    const next = nextRovingIndex(index, event.key, enabled.length);
    if (next === undefined) return;
    event.preventDefault();
    for (const button of buttons) button.tabIndex = -1;
    const target = enabled[next];
    if (target === undefined) return;
    target.tabIndex = 0;
    target.focus();
  });
  toolbar.append(...buttons);
  return toolbar;
}

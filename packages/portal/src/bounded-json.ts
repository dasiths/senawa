import type { JsonValue } from "@senawa/protocol";

export const JSON_NODE_LIMIT = 500;
export const JSON_STRING_PREFIX = 4_096;

export type BoundedJsonNode =
  | {
      readonly kind: "scalar";
      readonly label: string;
      readonly value: string;
      readonly truncated: boolean;
    }
  | {
      readonly kind: "array" | "object";
      readonly label: string;
      readonly children: readonly BoundedJsonNode[];
    }
  | { readonly kind: "limit"; readonly label: string; readonly value: string };

export interface BoundedJsonModel {
  readonly root: BoundedJsonNode;
  readonly visibleNodes: number;
  readonly truncated: boolean;
}

export function boundedJsonModel(
  value: JsonValue,
  nodeLimit = JSON_NODE_LIMIT,
  stringPrefix = JSON_STRING_PREFIX,
): BoundedJsonModel {
  if (!Number.isSafeInteger(nodeLimit) || nodeLimit < 1 || nodeLimit > JSON_NODE_LIMIT) {
    throw new TypeError(`JSON node limit must be between 1 and ${JSON_NODE_LIMIT}`);
  }
  if (
    !Number.isSafeInteger(stringPrefix) ||
    stringPrefix < 1 ||
    stringPrefix > JSON_STRING_PREFIX
  ) {
    throw new TypeError(`JSON string prefix must be between 1 and ${JSON_STRING_PREFIX}`);
  }
  const budget = { count: 0, limit: nodeLimit, truncated: false };
  const root = visit(value, "$", budget, stringPrefix);
  return Object.freeze({ root, visibleNodes: budget.count, truncated: budget.truncated });
}

function visit(
  value: JsonValue,
  label: string,
  budget: { count: number; limit: number; truncated: boolean },
  stringPrefix: number,
): BoundedJsonNode {
  if (budget.count >= budget.limit) {
    budget.truncated = true;
    return Object.freeze({
      kind: "limit",
      label,
      value: `Visible node limit ${budget.limit} reached`,
    });
  }
  budget.count += 1;
  if (value === null || typeof value !== "object") {
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    const truncated = encoded.length > stringPrefix;
    if (truncated) budget.truncated = true;
    return Object.freeze({
      kind: "scalar",
      label,
      value: truncated ? encoded.slice(0, stringPrefix) : encoded,
      truncated,
    });
  }
  if (Array.isArray(value)) {
    const children: BoundedJsonNode[] = [];
    for (const [index, child] of value.entries()) {
      if (budget.count >= budget.limit) {
        budget.truncated = true;
        break;
      }
      children.push(visit(child, String(index), budget, stringPrefix));
    }
    return Object.freeze({ kind: "array", label, children: Object.freeze(children) });
  }
  const object = value as { readonly [key: string]: JsonValue };
  const children: BoundedJsonNode[] = [];
  for (const key of Object.keys(object).sort()) {
    if (budget.count >= budget.limit) {
      budget.truncated = true;
      break;
    }
    const child = object[key];
    if (child !== undefined) children.push(visit(child, key, budget, stringPrefix));
  }
  return Object.freeze({ kind: "object", label, children: Object.freeze(children) });
}

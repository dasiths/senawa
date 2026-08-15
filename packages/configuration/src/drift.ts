import { canonicalSerialize, canonicalValue } from "@senawa/kernel";
import type {
  ConfigurationComponentCategory,
  ConfigurationDrift,
  ConfigurationSnapshot,
} from "./contracts.js";

const CATEGORIES: readonly ConfigurationComponentCategory[] = Object.freeze([
  "execution",
  "remote",
  "graph",
  "prompts",
  "schemas",
  "roles",
  "modelPolicies",
  "sensors",
  "gates",
  "implementationEvidenceViews",
  "phaseDataflow",
  "forEach",
  "taskTemplates",
]);

export function detectConfigurationDrift(
  accepted: ConfigurationSnapshot,
  current: ConfigurationSnapshot,
): ConfigurationDrift {
  const changedCategories = CATEGORIES.filter(
    (category) => accepted.componentDigests[category] !== current.componentDigests[category],
  );
  const changedKeys = changedCategories.flatMap((category) =>
    category === "execution"
      ? ["/execution"]
      : category === "remote"
        ? ["/remote"]
        : category === "graph"
          ? changedGraphKeys(accepted, current)
          : changedRegistryKeys(category, accepted[category], current[category]),
  );
  return Object.freeze({
    hasDrift: accepted.snapshotDigest !== current.snapshotDigest,
    acceptedSnapshotDigest: accepted.snapshotDigest,
    currentSnapshotDigest: current.snapshotDigest,
    acceptedGraphRevision: accepted.graph.revisionDigest,
    currentGraphRevision: current.graph.revisionDigest,
    changedCategories: Object.freeze(changedCategories),
    changedKeys: Object.freeze([...new Set(changedKeys)].sort(compareText)),
  });
}

function changedGraphKeys(
  accepted: ConfigurationSnapshot,
  current: ConfigurationSnapshot,
): readonly string[] {
  const acceptedNodes = new Map(
    accepted.graph.nodes.map((node) => [
      node.definition.id,
      canonicalSerialize(canonicalValue(node.definition)),
    ]),
  );
  const currentNodes = new Map(
    current.graph.nodes.map((node) => [
      node.definition.id,
      canonicalSerialize(canonicalValue(node.definition)),
    ]),
  );
  const pointers = new Map(
    [...accepted.graph.nodes, ...current.graph.nodes].map((node) => [
      node.definition.id,
      node.definition.source.pointer,
    ]),
  );
  return [...new Set([...acceptedNodes.keys(), ...currentNodes.keys()])]
    .filter((id) => acceptedNodes.get(id) !== currentNodes.get(id))
    .map((id) => pointers.get(id) as string);
}

function changedRegistryKeys(
  category: Exclude<ConfigurationComponentCategory, "execution" | "remote" | "graph">,
  accepted: readonly { readonly key: string; readonly digest: string }[],
  current: readonly { readonly key: string; readonly digest: string }[],
): readonly string[] {
  const acceptedEntries = new Map(accepted.map((entry) => [entry.key, entry.digest]));
  const currentEntries = new Map(current.map((entry) => [entry.key, entry.digest]));
  return [...new Set([...acceptedEntries.keys(), ...currentEntries.keys()])]
    .filter((key) => acceptedEntries.get(key) !== currentEntries.get(key))
    .map((key) => `/${category}/${escapePointer(key)}`);
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

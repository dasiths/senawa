import {
  AUTHORED_DOCUMENT_NAMES,
  type AuthoredWorkflowInput,
  ConfigurationCompilationError,
  type ConfigurationDiagnostic,
  type ConfigurationSnapshot,
  doctorWorkflowConfiguration,
  listAuthoredPromptPaths,
  lowerAuthoredWorkflow,
} from "@senawa/configuration";
import type { Sha256 } from "@senawa/kernel";
import { RootScopedConfigurationResources } from "./configuration-resource-files.js";

export interface AuthoredWorkflowLoadResult {
  readonly diagnostics: readonly ConfigurationDiagnostic[];
  readonly snapshot?: ConfigurationSnapshot;
}

/**
 * Reads a project's authored workflow and compiles it.
 *
 * Every read goes through the confined resource reader, so nothing here can
 * reach outside the configuration directory or follow a symbolic link out of it.
 */
export async function loadAuthoredWorkflow(
  projectRoot: string,
  sha256: Sha256,
  configurationDirectory = ".senawa",
): Promise<AuthoredWorkflowLoadResult> {
  const resources = await RootScopedConfigurationResources.create(
    projectRoot,
    configurationDirectory,
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const documents = new Map<string, string>();
  for (const name of AUTHORED_DOCUMENT_NAMES) {
    try {
      documents.set(name, decoder.decode(await resources.readAuthoredDocument(name)));
    } catch (error) {
      return {
        diagnostics: [
          {
            code: "resource-read-failed",
            locator: name,
            pointer: "",
            message: `Could not read ${name}: ${error instanceof Error ? error.message : "unknown"}`,
          },
        ],
      };
    }
  }

  const agentsText = documents.get("agents.yaml") ?? "";
  const prompts = new Map<string, string>();
  for (const path of listAuthoredPromptPaths({ path: "agents.yaml", text: agentsText })) {
    try {
      prompts.set(path, decoder.decode(await resources.read({ kind: "prompt", path, maxBytes })));
    } catch (error) {
      return {
        diagnostics: [
          {
            code: "resource-read-failed",
            locator: "agents.yaml",
            pointer: "",
            message: `Could not read prompt ${path}: ${error instanceof Error ? error.message : "unknown"}`,
          },
        ],
      };
    }
  }

  const input: AuthoredWorkflowInput = {
    agents: { path: "agents.yaml", text: agentsText },
    workflow: { path: "workflow.yaml", text: documents.get("workflow.yaml") ?? "" },
    sensors: { path: "sensors.yaml", text: documents.get("sensors.yaml") ?? "" },
    prompts,
  };
  const lowered = lowerAuthoredWorkflow(input);
  if (lowered.document === undefined || lowered.diagnostics.length > 0) {
    return { diagnostics: lowered.diagnostics };
  }

  const compiled = await doctorWorkflowConfiguration(
    { document: lowered.document, locator: `${configurationDirectory}/workflow.yaml`, resources },
    sha256,
  );
  return compiled.snapshot === undefined
    ? { diagnostics: compiled.diagnostics }
    : { diagnostics: compiled.diagnostics, snapshot: compiled.snapshot };
}

/** Compiles an authored workflow, throwing the diagnostics when it cannot. */
export async function compileAuthoredWorkflow(
  projectRoot: string,
  sha256: Sha256,
  configurationDirectory = ".senawa",
): Promise<ConfigurationSnapshot> {
  const result = await loadAuthoredWorkflow(projectRoot, sha256, configurationDirectory);
  if (result.snapshot === undefined) throw new ConfigurationCompilationError(result.diagnostics);
  return result.snapshot;
}

const maxBytes = 256 * 1_024;

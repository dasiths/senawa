#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const OPERATORS = new Set(["equals", "notEquals", "greaterThan", "greaterThanOrEqual", "contains", "matches", "exists"]);

const manifestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["apiVersion", "name", "version", "description", "kind", "configSchema", "inputSchema", "outputSchema"],
  properties: {
    apiVersion: { const: "senawa.dev/sensor/v1" },
    name: { type: "string", pattern: "^[a-z][a-z0-9-]*$" },
    version: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    kind: { enum: ["deterministic", "inferential"] },
    configSchema: { type: "object" },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  },
};

function formatErrors(errors = []) {
  return errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
}

function sanitize(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/<\/?(system|instructions?|important)>/gi, "[stripped-tag]");
}

async function loadRegistry(configPath) {
  const absoluteConfig = resolve(configPath);
  const root = dirname(absoluteConfig);
  const config = parseYaml(readFileSync(absoluteConfig, "utf8"));
  const extensions = new Map();
  const issues = [];

  for (const reference of config.extensions ?? []) {
    if (!reference.path) {
      issues.push("this POC supports explicit path extensions only");
      continue;
    }
    const modulePath = resolve(root, reference.path);
    const extension = await import(pathToFileURL(modulePath));
    const validManifest = ajv.compile(manifestSchema);
    if (!validManifest(extension.manifest)) {
      issues.push(`${reference.path}: invalid manifest: ${formatErrors(validManifest.errors)}`);
      continue;
    }
    try {
      ajv.compile(extension.manifest.configSchema);
      ajv.compile(extension.manifest.inputSchema);
      ajv.compile(extension.manifest.outputSchema);
    } catch (error) {
      issues.push(`${reference.path}: schema does not compile: ${error.message}`);
      continue;
    }
    if (extensions.has(extension.manifest.name)) issues.push(`duplicate extension ${extension.manifest.name}`);
    extensions.set(extension.manifest.name, extension);
  }

  const sensors = new Map();
  for (const sensor of config.sensors ?? []) {
    if (sensors.has(sensor.id)) issues.push(`duplicate sensor ${sensor.id}`);
    const extension = extensions.get(sensor.extension);
    if (!extension) {
      issues.push(`${sensor.id}: extension ${sensor.extension} is not loaded`);
      continue;
    }
    const validConfig = ajv.compile(extension.manifest.configSchema);
    const validInput = ajv.compile(extension.manifest.inputSchema);
    if (!validConfig(sensor.config)) issues.push(`${sensor.id}: invalid config: ${formatErrors(validConfig.errors)}`);
    if (!validInput(sensor.input)) issues.push(`${sensor.id}: invalid input: ${formatErrors(validInput.errors)}`);
    sensors.set(sensor.id, { definition: sensor, extension });
  }

  for (const gate of config.gates ?? []) {
    let deterministic = 0;
    for (const check of gate.checks ?? []) {
      const sensor = sensors.get(check.sensor);
      if (!sensor) issues.push(`${gate.id}: sensor ${check.sensor} is not configured`);
      if (!OPERATORS.has(check.expect?.operator)) issues.push(`${gate.id}: unknown operator ${check.expect?.operator}`);
      if (sensor?.extension.manifest.kind === "deterministic" && !check.advisory) deterministic += 1;
    }
    if (deterministic === 0) issues.push(`${gate.id}: blocking gate has no deterministic sensor`);
  }
  return { root, config, extensions, sensors, issues };
}

function makeAgentHost(validateOutput) {
  return {
    async runStructured({ outputSchema, maxSubmissions }) {
      const validate = validateOutput ?? ajv.compile(outputSchema);
      const candidates = [
        { verdict: "maybe", summary: "free-form model mistake", findings: [] },
        {
          verdict: "pass",
          summary: "No structural rule was violated",
          findings: [],
          data: { submissionAttempts: 2 },
        },
      ];
      const errors = [];
      for (const candidate of candidates.slice(0, maxSubmissions)) {
        if (validate(candidate)) return candidate;
        errors.push(formatErrors(validate.errors));
      }
      throw new Error(`reviewer never submitted a valid result: ${errors.join(" | ")}`);
    },
  };
}

async function runSensor(registry, id) {
  const registered = registry.sensors.get(id);
  if (!registered) throw new Error(`unknown sensor ${id}`);
  const { definition, extension } = registered;
  const sensor = extension.create(definition.config);
  const validateOutput = ajv.compile(extension.manifest.outputSchema);
  const started = Date.now();
  try {
    const assessment = await sensor.run(definition.input, {
      root: registry.root,
      sanitize,
      agents: makeAgentHost(validateOutput),
    });
    if (!validateOutput(assessment)) throw new Error(`invalid output: ${formatErrors(validateOutput.errors)}`);
    return { sensor: id, status: "completed", assessment, durationMs: Date.now() - started };
  } catch (error) {
    return { sensor: id, status: "error", error: { message: sanitize(error.message) }, durationMs: Date.now() - started };
  }
}

const args = process.argv.slice(2);
const configIndex = args.indexOf("--config");
const configPath = configIndex >= 0 ? args.splice(configIndex, 2)[1] : "sensors.yaml";
const json = args.includes("--json");
if (json) args.splice(args.indexOf("--json"), 1);
const registry = await loadRegistry(configPath);

if (args[0] === "doctor") {
  if (registry.issues.length) {
    for (const issue of registry.issues) console.error(`error: ${issue}`);
    process.exit(1);
  }
  console.log(`ok: ${registry.extensions.size} extensions, ${registry.sensors.size} sensors, ${(registry.config.gates ?? []).length} gates`);
} else if (args[0] === "sensor" && args[1] === "list") {
  const rows = [...registry.sensors].map(([id, value]) => ({
    id,
    description: value.definition.description,
    extension: value.extension.manifest.name,
    kind: value.extension.manifest.kind,
    loaded: !registry.issues.some((issue) => issue.startsWith(`${id}:`)),
  }));
  console.log(json ? JSON.stringify(rows, null, 2) : rows.map((row) => `${row.id}\t${row.kind}\t${row.description}`).join("\n"));
} else if (args[0] === "sensor" && args[1] === "info") {
  const registered = registry.sensors.get(args[2]);
  if (!registered) throw new Error(`unknown sensor ${args[2]}`);
  const info = {
    id: args[2],
    description: registered.definition.description,
    extension: registered.extension.manifest.name,
    extensionDescription: registered.extension.manifest.description,
    configSchema: registered.extension.manifest.configSchema,
    inputSchema: registered.extension.manifest.inputSchema,
    outputSchema: registered.extension.manifest.outputSchema,
  };
  console.log(JSON.stringify(info, null, 2));
} else if (args[0] === "sensor" && args[1] === "run") {
  if (registry.issues.length) throw new Error(`configuration is invalid; run doctor`);
  const ids = args[2] ? [args[2]] : [...registry.sensors.keys()];
  const readings = [];
  for (const id of ids) readings.push(await runSensor(registry, id));
  console.log(JSON.stringify(readings, null, 2));
  if (readings.some((reading) => reading.status === "error" || reading.assessment?.verdict === "fail")) process.exit(1);
} else {
  console.error("usage: cli.mjs doctor | sensor list|info <id>|run [id]");
  process.exit(2);
}

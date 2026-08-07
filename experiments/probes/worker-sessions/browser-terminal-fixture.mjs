import { readFile } from "node:fs/promises";

export const terminalProjectionLimits = Object.freeze({
  maxCharsPerStream: 1_024,
  maxCharsPerLine: 256,
  maxLifecycleRecords: 20,
});

const ansiEscapePattern = new RegExp(
  `${String.fromCodePoint(27)}(?:\\][^${String.fromCodePoint(7)}]*(?:${String.fromCodePoint(7)}|${String.fromCodePoint(27)}\\\\)|\\[[0-?]*[ -/]*[@-~])`,
  "gu",
);
const unsafeControlPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const secretPattern = /\b(token|password|secret)=\S+/giu;

export function sanitizeTerminalText(value, probeRoot, limits = terminalProjectionLimits) {
  const normalized = value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(ansiEscapePattern, "")
    .replace(unsafeControlPattern, "")
    .replaceAll(probeRoot, "[probe-root]")
    .replace(secretPattern, "$1=[redacted]");
  const boundedLines = normalized
    .split("\n")
    .map((line) => truncate(line, limits.maxCharsPerLine, "...[line truncated]"))
    .join("\n");
  return truncate(boundedLines, limits.maxCharsPerStream, "\n...[stream truncated]");
}

export async function projectBrowserTerminal(input) {
  const [stdout, stderr, pane, lifecycleText] = await Promise.all([
    readOptional(input.stdoutPath),
    readOptional(input.stderrPath),
    Promise.resolve(input.paneCapture),
    readOptional(input.lifecyclePath),
  ]);
  const lifecycle = lifecycleText
    .split("\n")
    .filter(Boolean)
    .slice(-terminalProjectionLimits.maxLifecycleRecords)
    .map((line) => JSON.parse(line));
  return {
    apiVersion: "senawa.dev/browser-worker-terminal/v1",
    runId: input.runId,
    owner: input.owner,
    sessionId: input.sessionId,
    turnId: input.turnId,
    tmux: {
      socket: input.socket,
      session: input.tmuxSession,
      paneId: input.paneId,
      panePid: input.panePid,
    },
    status: input.paneDead ? "exited" : "running",
    exitCode: input.paneDead ? input.exitCode : null,
    streams: {
      stdout: sanitizeTerminalText(stdout, input.probeRoot),
      stderr: sanitizeTerminalText(stderr, input.probeRoot),
      pane: sanitizeTerminalText(pane, input.probeRoot),
    },
    lifecycle,
  };
}

export function createBrowserTerminalStore(terminals) {
  return Object.fromEntries(terminals.map((terminal) => [terminal.turnId, structuredClone(terminal)]));
}

export function applyBrowserTerminalUpdate(store, terminal) {
  return { ...store, [terminal.turnId]: structuredClone(terminal) };
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function truncate(value, maximum, marker) {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - marker.length))}${marker}`;
}
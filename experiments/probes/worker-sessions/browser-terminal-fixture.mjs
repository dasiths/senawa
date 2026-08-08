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

// Single source of truth for the assignment keys the sanitizer redacts.
export const redactedKeys = Object.freeze(["token", "password", "secret"]);
const redactionMarker = "[redacted]";
const keyAlternation = redactedKeys.join("|");
// Only tmux `capture-pane` output can hard-wrap: tmux inserts the wrap at the
// pane width mid-value, with no whitespace on either side of the break.
// stdout and stderr are read directly from files via emit_stdout/emit_stderr
// and are never wrapped by tmux, so a bare `\n` there is always a genuine line
// boundary and must remain a hard stop for the default pattern below.
//
// The pane-capture pattern additionally allows the value's first run of
// non-whitespace to be followed by at most one such wrap continuation: a bare
// `\n` immediately followed by more non-whitespace. Bounding the continuation
// to one keeps a real line break (followed by whitespace, another `\n`, or
// end of text) a hard stop, so an unrelated line after the wrapped secret is
// never absorbed into the match.
const defaultSecretPattern = new RegExp(`\\b(${keyAlternation})=\\S+`, "giu");
const paneCaptureSecretPattern = new RegExp(
  `\\b(${keyAlternation})=\\S+(?:\\n(?=\\S)\\S*)?`,
  "giu",
);
const redactedAssignmentPattern = new RegExp(
  `\\b(?:${keyAlternation})=${redactionMarker.replaceAll(/[[\]]/gu, String.raw`\$&`)}`,
  "giu",
);
// Once every redacted assignment is removed, any surviving escape or redaction
// keyword is leaked residue: an unredacted value, a bare secret word, or a raw
// control sequence.
const residuePattern = new RegExp(
  `${String.fromCodePoint(27)}|\\b(?:${keyAlternation})\\b`,
  "iu",
);

export function findTerminalResidue(text) {
  return residuePattern.exec(text.replace(redactedAssignmentPattern, ""))?.[0] ?? null;
}

// `streamKind` selects the secret pattern: only `"paneCapture"` (the only
// stream tmux can hard-wrap) opts into the wrap-continuation clause. Every
// other stream kind, including the default, uses the plain pattern so a real
// newline in file-backed stdout/stderr is never treated as a continuation.
export function sanitizeTerminalText(
  value,
  probeRoot,
  limits = terminalProjectionLimits,
  streamKind = "default",
) {
  const secretPattern = streamKind === "paneCapture" ? paneCaptureSecretPattern : defaultSecretPattern;
  const normalized = value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(ansiEscapePattern, "")
    .replace(unsafeControlPattern, "")
    .replaceAll(probeRoot, "[probe-root]")
    .replace(secretPattern, `$1=${redactionMarker}`);
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
      pane: sanitizeTerminalText(pane, input.probeRoot, terminalProjectionLimits, "paneCapture"),
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
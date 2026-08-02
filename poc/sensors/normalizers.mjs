// Every parser turns one tool's idea of an error into the SAME shape:
//   { file, line, column, message, severity }
// This is the contract that lets the gate treat tsc, eslint, node and python
// identically, and lets a worker read one format regardless of which sensor
// went red. Adding a language means adding a function here, nothing else.

const clip = (s, n = 300) => (s.length > n ? s.slice(0, n) + "…" : s);

// Sensor output is untrusted input heading for a model's context window.
// Strip control characters and anything that looks like an attempt to open a
// new instruction block.
export function sanitize(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/<\/?(system|instructions?|important)>/gi, "[stripped-tag]");
}

// node --check  ->  "file:line\n...\nSyntaxError: message"
export function nodeCheck(out) {
  const m = out.match(/^(.*?):(\d+)\n/m);
  const err = out.match(/^((?:SyntaxError|ReferenceError|TypeError).*)$/m);
  return m
    ? [{ file: m[1], line: Number(m[2]), column: null, severity: "error", message: clip(err?.[1] ?? "syntax error") }]
    : [];
}

// python3 -m py_compile  ->  'File "x.py", line N' + final error line
export function pythonCompile(out) {
  const m = out.match(/File "(.+?)", line (\d+)/);
  const err = out.match(/^(\w*(?:Error|Warning):.*)$/m);
  return m
    ? [{ file: m[1], line: Number(m[2]), column: null, severity: "error", message: clip(err?.[1] ?? "compile error") }]
    : [];
}

// eslint --format json  ->  [{ filePath, messages: [{ line, column, message, ruleId, severity }] }]
export function eslintJson(out) {
  const start = out.indexOf("[");
  if (start < 0) return [];
  let parsed;
  try { parsed = JSON.parse(out.slice(start)); } catch { return []; }
  return parsed.flatMap((f) =>
    (f.messages ?? []).map((m) => ({
      file: f.filePath,
      line: m.line ?? null,
      column: m.column ?? null,
      severity: m.severity === 2 ? "error" : "warning",
      message: clip(`${m.message}${m.ruleId ? ` (${m.ruleId})` : ""}`),
    })),
  );
}

// tsc --pretty false  ->  "file(line,col): error TS1234: message"
export function tscText(out) {
  return out
    .split("\n")
    .map((l) => l.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4],
      message: clip(`${m[6]} (${m[5]})`),
    }));
}

// Anything with no parser: keep the first few non-empty lines, sanitized.
export function raw(out) {
  return sanitize(out)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((message) => ({ file: null, line: null, column: null, severity: "error", message: clip(message) }));
}

export const PARSERS = {
  "node-check": nodeCheck,
  "python-compile": pythonCompile,
  "eslint-json": eslintJson,
  "tsc-text": tscText,
  raw,
};

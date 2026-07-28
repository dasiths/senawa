// POC 08 - the sensor runner.
//
// Checks four properties the design depends on:
//   1. NORMALIZATION - four different tools produce one findings[] shape
//   2. ORDERING      - cheap sensors short-circuit expensive ones
//   3. CACHING       - fingerprinted readings are reused until inputs change
//   4. HYGIENE       - hostile sensor output is defanged before it is forwarded
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { PARSERS, sanitize } from "./normalizers.mjs";

const hdr = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`);
const note = (s) => console.log(`   ${s}`);

const cfg = parseYaml(readFileSync(new URL("./sensors.yaml", import.meta.url), "utf8"));
const CACHE = new URL("./.cache.json", import.meta.url);
const COST_ORDER = { trivial: 0, cheap: 1, medium: 2, expensive: 3 };

const loadCache = () => (existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {});
const saveCache = (c) => writeFileSync(CACHE, JSON.stringify(c, null, 2));

// A reading is keyed by (sensor definition, contents of the files it reads).
// Change either and the cached verdict is void; change neither and re-running
// the sensor cannot tell you anything new.
function fingerprint(sensor) {
  const h = createHash("sha256");
  h.update(JSON.stringify({ run: sensor.run, parser: sensor.parser ?? null }));
  for (const f of ["fixture/bad.js", "fixture/broken.py", "fixture/src/parse.ts", "fixture/hostile.mjs"]) {
    const p = new URL(`./${f}`, import.meta.url);
    if (existsSync(p)) h.update(readFileSync(p));
  }
  return "sha256:" + h.digest("hex").slice(0, 16);
}

function runOne(sensor) {
  const started = Date.now();
  let out = "";
  let ok = true;
  try {
    out = execSync(sensor.run, {
      cwd: new URL(".", import.meta.url).pathname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: (cfg.defaults?.timeout_sec ?? 60) * 1000,
    });
  } catch (err) {
    ok = false;
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const parse = PARSERS[sensor.parser ?? "raw"] ?? PARSERS.raw;
  const findings = ok ? [] : parse(out).map((f) => ({ ...f, message: sanitize(f.message) }));
  return {
    sensor: sensor.id,
    verdict: ok ? "pass" : "fail",
    duration_ms: Date.now() - started,
    findings,
    raw_bytes: out.length,
  };
}

export function runAll({ useCache = true, only = null } = {}) {
  const cache = useCache ? loadCache() : {};
  const deterministic = cfg.sensors
    .filter((s) => s.kind === "deterministic")
    .filter((s) => !only || only.includes(s.id))
    .sort((a, b) => COST_ORDER[a.cost] - COST_ORDER[b.cost]);

  const readings = [];
  let skipped = [];
  for (let i = 0; i < deterministic.length; i++) {
    const s = deterministic[i];
    const fp = fingerprint(s);
    const hit = cache[s.id]?.fingerprint === fp ? cache[s.id] : null;
    const reading = hit
      ? { ...hit.reading, cached: true, duration_ms: 0 }
      : { ...runOne(s), cached: false };
    readings.push(reading);
    if (!hit) cache[s.id] = { fingerprint: fp, reading: { ...reading, cached: undefined } };

    if (reading.verdict === "fail") {
      skipped = deterministic.slice(i + 1).map((x) => x.id);
      break; // short-circuit: nothing later can change the answer
    }
  }
  if (useCache) saveCache(cache);
  return { readings, skipped };
}

// --------------------------------------------------------------------------
if (process.argv[1] === new URL(import.meta.url).pathname) {
  hdr("1. NORMALIZATION - four tools, one findings shape");
  const { readings, skipped } = runAll({ useCache: false });
  const all = runAll({ useCache: false, only: cfg.sensors.filter((s) => s.kind === "deterministic").map((s) => s.id) });
  // Run each in isolation so every parser is exercised, not just up to the first red.
  for (const s of cfg.sensors.filter((x) => x.kind === "deterministic")) {
    const r = runOne(s);
    const f = r.findings[0];
    note(
      `${s.id.padEnd(12)} ${r.verdict.padEnd(5)} ${String(r.raw_bytes).padStart(5)}B raw -> ` +
        (f
          ? `${(f.file ?? "-").split("/").pop()}:${f.line ?? "-"} ${JSON.stringify(f.message).slice(0, 72)}`
          : "no findings"),
    );
  }

  hdr("2. ORDERING - cheap sensors short-circuit expensive ones");
  note(`ran     : ${readings.map((r) => r.sensor).join(", ")}`);
  note(`skipped : ${skipped.join(", ") || "(none)"}`);
  note(`the expensive sensors never executed, which is the entire point`);

  hdr("3. CACHING - fingerprinted readings are reused");
  const cold = Date.now(); runAll({ useCache: false }); const coldMs = Date.now() - cold;
  runAll({ useCache: true }); // prime
  const warm = Date.now(); const second = runAll({ useCache: true }); const warmMs = Date.now() - warm;
  note(`cold run: ${coldMs} ms`);
  note(`cached  : ${warmMs} ms   (${second.readings.filter((r) => r.cached).length}/${second.readings.length} readings reused)`);

  const target = new URL("./fixture/bad.js", import.meta.url);
  const original = readFileSync(target, "utf8");
  writeFileSync(target, original + "\n// touched\n");
  const after = runAll({ useCache: true });
  note(`after editing a watched file: ${after.readings.filter((r) => r.cached).length}/${after.readings.length} reused (expect 0 - fingerprint invalidated)`);
  writeFileSync(target, original);

  hdr("4. HYGIENE - hostile sensor output is defanged");
  const hostile = runOne(cfg.sensors.find((s) => s.id === "unit-tests"));
  note(`raw output was ${hostile.raw_bytes} bytes`);
  note(`forwarded findings: ${hostile.findings.length}, longest ${Math.max(...hostile.findings.map((f) => f.message.length))} chars`);
  for (const f of hostile.findings) note(`  -> ${JSON.stringify(f.message)}`);
  const forwarded = JSON.stringify(hostile.findings);
  note(`contains control chars? ${/[\u0000-\u0008\u001b]/.test(forwarded)}`);
  note(`contains an injected instruction tag? ${/<system>|<important>/i.test(forwarded)}`);
  note(`total forwarded size: ${forwarded.length}B (cap ${cfg.defaults.max_evidence_bytes}B)`);
}

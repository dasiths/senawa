// POC 08b - Is an inferential sensor stable enough to gate on?
//
// This is the question the design defers with "start advisory, promote on
// measured trust". Promotion needs a measurement, so here it is: run the SAME
// rubric against the SAME unchanged file N times and see whether the verdict
// and the findings hold still.
//
// A deterministic sensor scores 1.0 on this by construction. Whatever an
// inferential sensor scores is the discount you are applying when you let it
// block work.
//
// SPENDS AI CREDITS: N short prompts (default 5).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const N = Number(process.env.N ?? 5);
const MODEL = process.env.MODEL ?? "claude-haiku-4.5";
const SUBJECT = process.env.SUBJECT ?? "fixture/src/parse.ts";
const hdr = (s) => console.log(`\n\x1b[1m== ${s}\x1b[0m`);
const note = (s) => console.log(`   ${s}`);

const rubric = readFileSync(new URL("./rubric.md", import.meta.url), "utf8");
const subject = readFileSync(new URL(`./${SUBJECT}`, import.meta.url), "utf8");

const PROMPT = `${rubric}

Review this file against the rubric.

\`\`\`typescript
${subject}
\`\`\`

Reply with ONLY a JSON object, no prose and no code fence:
{"verdict":"pass"|"fail","findings":[{"rule":<number>,"symbol":"<name>","message":"<one line>"}]}`;

function runOnce(i) {
  const started = Date.now();
  const out = execFileSync(
    "copilot",
    ["-p", PROMPT, "-s", "--model", MODEL, "--allow-all-tools", "--no-ask-user"],
    { encoding: "utf8", timeout: 180000, stdio: ["ignore", "pipe", "pipe"] },
  );
  const m = out.match(/\{[\s\S]*\}/);
  let parsed = null;
  try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
  return { i, ms: Date.now() - started, parsed, raw: out.trim().slice(0, 200) };
}

hdr(`running the same rubric ${N}x against an unchanged file (${MODEL})`);
note(`subject: ${SUBJECT}`);
const runs = [];
for (let i = 1; i <= N; i++) {
  const r = runOnce(i);
  runs.push(r);
  const rules = r.parsed?.findings?.map((f) => f.rule).sort().join(",") ?? "-";
  note(
    `run ${i}: verdict=${(r.parsed?.verdict ?? "UNPARSEABLE").padEnd(11)} ` +
      `findings=${String(r.parsed?.findings?.length ?? "?").padEnd(2)} rules=[${rules}] ${r.ms}ms`,
  );
}

hdr("stability");
const parsed = runs.filter((r) => r.parsed);
note(`parseable responses     : ${parsed.length}/${N}`);

const verdicts = {};
for (const r of parsed) verdicts[r.parsed.verdict] = (verdicts[r.parsed.verdict] ?? 0) + 1;
note(`verdict distribution    : ${JSON.stringify(verdicts)}`);
const majority = Object.entries(verdicts).sort((a, b) => b[1] - a[1])[0];
note(`verdict agreement       : ${majority ? Math.round((majority[1] / parsed.length) * 100) : 0}% chose "${majority?.[0]}"`);

// How often does each rule get cited? A rule cited 5/5 is a candidate for
// encoding as a deterministic check. A rule cited 2/5 is noise.
const ruleCounts = {};
for (const r of parsed) {
  for (const rule of new Set((r.parsed.findings ?? []).map((f) => f.rule))) {
    ruleCounts[rule] = (ruleCounts[rule] ?? 0) + 1;
  }
}
note(`rule citation frequency :`);
for (const [rule, count] of Object.entries(ruleCounts).sort((a, b) => b[1] - a[1])) {
  note(`   rule ${rule}: ${count}/${parsed.length} runs  ${"█".repeat(count)}`);
}

const counts = parsed.map((r) => r.parsed.findings?.length ?? 0);
note(`findings per run        : min ${Math.min(...counts)}, max ${Math.max(...counts)}`);

hdr("reading");
if (majority && majority[1] === parsed.length && parsed.length === N) {
  note("Verdict was unanimous. Promotion to a blocking gate is defensible for");
  note("THIS rubric on THIS input; re-measure on real diffs before trusting it.");
} else {
  note("Verdict varied across identical input. This sensor must stay advisory:");
  note("gating on it would create backpressure the worker cannot reproduce,");
  note("which is indistinguishable from a flaky test.");
}

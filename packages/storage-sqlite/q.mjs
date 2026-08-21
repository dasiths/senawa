import Database from "better-sqlite3";
const d = new Database(
  "/workspaces/senawa/examples/rpi-workflow/.senawa-state/senawa/authority.db",
  { readonly: true },
);
console.log("runner commands:", d.prepare("SELECT COUNT(*) n FROM runner_commands").get().n);
console.log("intents:", d.prepare("SELECT COUNT(*) n FROM runner_effect_intents").get().n);
console.log("outcomes:", d.prepare("SELECT status, COUNT(*) n FROM runner_effect_outcomes GROUP BY status").all());
console.log("\ntranscript:");
for (const r of d.prepare("SELECT owner_id, sequence, occurred_at, text FROM agent_transcript_lines ORDER BY run_sequence").all())
  console.log(" ", String(r.owner_id).slice(9, 21), String(r.sequence).padStart(2), r.occurred_at.slice(11, 19), r.text.slice(0, 80));

import Database from "better-sqlite3";
const d = new Database(
  "/workspaces/senawa/examples/rpi-workflow/.senawa-state/senawa/authority.db",
  { readonly: true },
);
console.log("=== transcript (what an agent terminal shows) ===");
for (const r of d.prepare("SELECT owner_id, sequence, occurred_at, text FROM agent_transcript_lines ORDER BY run_sequence").all())
  console.log(String(r.owner_id).slice(9, 17), String(r.sequence).padStart(2), r.occurred_at.slice(11, 19), r.text.slice(0, 110));
console.log("\n=== questions asked ===");
const st = JSON.parse(d.prepare("SELECT canonical_json FROM context_authority_state WHERE singleton = 1").get().canonical_json);
for (const q of st.questions ?? []) console.log(" ", JSON.stringify(q).slice(0, 300));

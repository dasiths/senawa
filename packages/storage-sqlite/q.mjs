import Database from "better-sqlite3";
const d = new Database(
  "/workspaces/senawa/examples/rpi-workflow/.senawa-state/senawa/authority.db",
  { readonly: true },
);
const q = (sql) => { try { return d.prepare(sql).get(); } catch { return undefined; } };
console.log("phase outputs:", d.prepare("SELECT output_name, byte_length FROM phase_output_publications").all());
console.log("largest command envelope:", q("SELECT MAX(length(canonical_envelope)) n FROM commands"));
console.log("largest transcript line:", q("SELECT MAX(length(text)) n FROM agent_transcript_lines"));
console.log("largest submission:", q("SELECT MAX(length(canonical_submission)) n FROM context_submissions"));

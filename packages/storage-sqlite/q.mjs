import Database from "better-sqlite3";
import { createHash } from "node:crypto";
const d = new Database(
  "/workspaces/senawa/examples/rpi-workflow/.senawa-state/senawa/authority.db",
  { readonly: true },
);
const stored = new Map();
for (const r of d.prepare("SELECT command_id, canonical_envelope FROM commands").all()) {
  if (!String(r.command_id).startsWith("command_completion-")) continue;
  stored.set(r.command_id, JSON.parse(r.canonical_envelope));
}
const st = JSON.parse(d.prepare("SELECT canonical_json FROM context_authority_state WHERE singleton = 1").get().canonical_json);
console.log("outbox entries:", st.completionOutbox.length);
for (const e of st.completionOutbox) {
  const suffix = `completion-${e.submissionId.replace("submission_", "").slice(0, 20)}`;
  const match = [...stored.keys()].find((k) => k.startsWith(`command_${suffix}-`));
  const dispatch = st.dispatches.find((x) => x.dispatchId === e.fact.dispatchId);
  console.log(
    suffix.slice(0, 32),
    "delivered:", e.delivered,
    "storedGraphRev:", match ? String(stored.get(match).expectedGraphRevision).slice(0, 12) : "none",
    "dispatchGraphRev:", String(dispatch?.context?.graphRevisionDigest).slice(0, 12),
  );
}

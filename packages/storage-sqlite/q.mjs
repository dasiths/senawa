import Database from "better-sqlite3";
const d = new Database(
  "/workspaces/senawa/examples/rpi-workflow/.senawa-state/senawa/authority.db",
  { readonly: true },
);
for (const r of d.prepare("SELECT recorded_at, level, event, message, fields_json FROM supervisor_logs ORDER BY cursor DESC LIMIT 6").all())
  console.log(r.level, r.event, "|", String(r.message).slice(0, 90), "|", String(r.fields_json ?? "").slice(0, 90));

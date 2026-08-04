import { decideHook, type HookEvent, type HookPayload } from "./policy.js";

const event = process.argv[2];
if (!isHookEvent(event)) {
  process.stderr.write("Usage: senawa-hook <pre-tool|permission|post-edit>\n");
  process.exitCode = 2;
} else {
  try {
    const raw = await readStdin();
    const payload = raw.trim() === "" ? {} : (JSON.parse(raw) as HookPayload);
    process.stdout.write(JSON.stringify(decideHook(event, payload)));
  } catch (error) {
    process.stderr.write(
      `senawa-hook: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}

function isHookEvent(value: string | undefined): value is HookEvent {
  return value === "pre-tool" || value === "permission" || value === "post-edit";
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);
    length += buffer.length;
    if (length > 64 * 1024) throw new Error("hook payload exceeds 64 KiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

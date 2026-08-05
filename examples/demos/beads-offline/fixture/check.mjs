const mode = process.argv[2];

if (mode === "typecheck") {
  process.stdout.write("Beads demo fixture typecheck passed.\n");
  process.exit(0);
}

if (mode === "test") {
  const attempt = Number(process.env.SENAWA_ATTEMPT ?? "0");
  if (attempt === 1) {
    process.stderr.write("Beads demo fixture intentionally fails on attempt 1.\n");
    process.exit(1);
  }
  process.stdout.write(`Beads demo fixture tests passed on attempt ${attempt}.\n`);
  process.exit(0);
}

process.stderr.write(`Unknown Beads demo check: ${mode ?? "missing"}\n`);
process.exit(2);

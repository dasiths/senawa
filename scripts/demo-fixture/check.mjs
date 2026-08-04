const mode = process.argv[2];

if (mode === "typecheck") {
  process.stdout.write("Demo fixture typecheck passed.\n");
  process.exit(0);
}

if (mode === "test") {
  const attempt = Number(process.env.SENAWA_ATTEMPT ?? "0");
  if (attempt === 1) {
    process.stderr.write("Demo fixture intentionally fails on attempt 1.\n");
    process.exit(1);
  }
  process.stdout.write(`Demo fixture tests passed on attempt ${attempt}.\n`);
  process.exit(0);
}

process.stderr.write(`Unknown demo check: ${mode ?? "missing"}\n`);
process.exit(2);

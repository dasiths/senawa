export const SENAWA_VERSION = "0.1.0-alpha.0";

const HELP = `Senawa ${SENAWA_VERSION}

Usage: senawa [--help] [--version]

The alpha implementation reset currently exposes no workflow commands.`;

export function renderCli(arguments_: readonly string[]): { output: string; exitCode: number } {
  if (arguments_.length === 0 || arguments_.includes("--help") || arguments_.includes("-h")) {
    return { output: HELP, exitCode: 0 };
  }
  if (arguments_.includes("--version") || arguments_.includes("-v")) {
    return { output: SENAWA_VERSION, exitCode: 0 };
  }
  return {
    output: `Unknown argument: ${arguments_[0]}\n\n${HELP}`,
    exitCode: 1,
  };
}

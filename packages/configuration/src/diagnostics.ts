import type { ConfigurationDiagnostic } from "./contracts.js";

export class ConfigurationCompilationError extends Error {
  readonly diagnostics: readonly ConfigurationDiagnostic[];

  constructor(diagnostics: readonly ConfigurationDiagnostic[]) {
    super(
      `Configuration compilation failed with ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}`,
    );
    this.name = "ConfigurationCompilationError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

export function sortDiagnostics(
  diagnostics: readonly ConfigurationDiagnostic[],
): readonly ConfigurationDiagnostic[] {
  return Object.freeze(
    [...diagnostics].sort(
      (left, right) =>
        compareText(left.locator, right.locator) ||
        compareText(left.pointer, right.pointer) ||
        compareText(left.code, right.code) ||
        compareText(left.message, right.message),
    ),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

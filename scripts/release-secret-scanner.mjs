import { TextDecoder } from "node:util";
import ts from "typescript";

const decoder = new TextDecoder("utf-8", { fatal: true });
const textAssetPattern = /(?:^package\.json$|\.(?:css|d\.ts|html|json|sql)$)/u;
const javascriptAssetPattern = /\.(?:cjs|js|mjs)$/u;
const highConfidencePatterns = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  /\b(?:authorization|proxy-authorization)\s*:\s*(?:basic|bearer)\s+[A-Za-z0-9+/_.=-]{8,}/iu,
  /https?:\/\/[^\s/@"']+:[^\s/@"']+@/iu,
  /\b(?:ghp|github_pat|sk|xox[baprs])_[A-Za-z0-9_-]{12,}/u,
]);
const credentialValuePattern =
  /["'](?:accessToken|apiKey|authorization|credential|password|privateKey|secret|token)["']\s*:\s*["'][^"'\r\n]{8,}["']/iu;
const releaseCredentialValues = Object.freeze(
  Object.entries(process.env)
    .filter(
      ([name, value]) =>
        /(?:access[_-]?token|api[_-]?key|authorization|credential|password|private[_-]?key|secret|token)/iu.test(
          name,
        ) &&
        typeof value === "string" &&
        value.length >= 8,
    )
    .map(([, value]) => value),
);

export function assertReleaseFileSecretSafe(
  bytes,
  path,
  forbiddenPaths = [],
  credentialValues = releaseCredentialValues,
) {
  if (!textAssetPattern.test(path) && !javascriptAssetPattern.test(path)) return;
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new TypeError(`Release text asset ${path} must be valid UTF-8`);
  }
  for (const forbiddenPath of forbiddenPaths) {
    if (forbiddenPath.length > 0 && text.includes(forbiddenPath)) {
      throw new TypeError(`Release text asset ${path} contains a source or workspace path`);
    }
  }
  assertHighConfidenceSecretSafe(text, path);
  if (javascriptAssetPattern.test(path)) {
    scanJavaScriptLiterals(text, path, credentialValues);
  } else if (credentialValuePattern.test(text)) {
    throw new TypeError(`Release text asset ${path} contains a credential-shaped value`);
  }
}

function assertHighConfidenceSecretSafe(text, path) {
  if (highConfidencePatterns.some((pattern) => pattern.test(text))) {
    throw new TypeError(`Release text asset ${path} contains secret-shaped content`);
  }
}

function scanJavaScriptLiterals(text, path, credentialValues) {
  if (credentialValues.some((value) => text.includes(value))) {
    throw new TypeError(`Release JavaScript asset ${path} contains a release credential value`);
  }
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS);
  const visit = (node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      highConfidencePatterns.some((pattern) => pattern.test(node.text))
    ) {
      throw new TypeError(`Release JavaScript asset ${path} contains a secret-shaped literal`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

export const PROMPT_TEMPLATE_LIMITS = Object.freeze({
  maxTokens: 256,
  maxDeclaredInputPaths: 256,
  maxInputPathCharacters: 1_024,
  maxInputPathSegments: 64,
  maxMappedInputBytes: 32 * 1_024,
  maxSubstitutionBytes: 16 * 1_024,
  maxAllSubstitutionsBytes: 32 * 1_024,
  maxPromptPackBytes: 64 * 1_024,
});

export interface PromptTemplateToken {
  readonly start: number;
  readonly end: number;
  readonly pointer: string;
}

export interface ParsedPromptTemplate {
  readonly tokens: readonly PromptTemplateToken[];
  readonly inputPaths: readonly string[];
}

export class PromptTemplateError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} at character offset ${offset}`);
    this.name = "PromptTemplateError";
    this.offset = offset;
  }
}

const TOKEN_PATTERN = /^\$\{\{[ \t]*input((?:\.[A-Za-z_][A-Za-z0-9_-]{0,63})+)[ \t]*\}\}/u;

export function parsePromptTemplate(template: string): ParsedPromptTemplate {
  const tokens: PromptTemplateToken[] = [];
  const inputPaths = new Set<string>();
  let offset = 0;
  while (offset < template.length) {
    const marker = template.indexOf("${{", offset);
    if (marker < 0) break;
    const match = TOKEN_PATTERN.exec(template.slice(marker));
    if (match === null) {
      throw new PromptTemplateError("Invalid prompt template token", marker);
    }
    if (tokens.length >= PROMPT_TEMPLATE_LIMITS.maxTokens) {
      throw new PromptTemplateError(
        `Prompt template cannot contain more than ${PROMPT_TEMPLATE_LIMITS.maxTokens} tokens`,
        marker,
      );
    }
    const accessor = match[1];
    if (accessor === undefined) {
      throw new PromptTemplateError("Prompt template token must select an input path", marker);
    }
    const pointer = accessor
      .slice(1)
      .split(".")
      .map(escapePointerSegment)
      .reduce((result, segment) => `${result}/${segment}`, "");
    const end = marker + match[0].length;
    tokens.push(Object.freeze({ start: marker, end, pointer }));
    inputPaths.add(pointer);
    offset = end;
  }
  return Object.freeze({
    tokens: Object.freeze(tokens),
    inputPaths: Object.freeze([...inputPaths].sort(compareText)),
  });
}

export function canonicalPromptInputPaths(paths: readonly string[]): readonly string[] {
  if (paths.length > PROMPT_TEMPLATE_LIMITS.maxDeclaredInputPaths) {
    throw new TypeError(
      `Prompt inputPaths cannot contain more than ${PROMPT_TEMPLATE_LIMITS.maxDeclaredInputPaths} paths`,
    );
  }
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (path.length === 0 || path.length > PROMPT_TEMPLATE_LIMITS.maxInputPathCharacters) {
      throw new TypeError("Prompt input path has an invalid length");
    }
    if (!path.startsWith("/") || path.endsWith("/") || path.includes("//")) {
      throw new TypeError(`Prompt input path ${path} is not a canonical JSON Pointer`);
    }
    const segments = path.slice(1).split("/");
    if (segments.length > PROMPT_TEMPLATE_LIMITS.maxInputPathSegments) {
      throw new TypeError("Prompt input path has too many segments");
    }
    for (const segment of segments) {
      if (segment.length === 0 || /~(?:[^01]|$)/u.test(segment)) {
        throw new TypeError(`Prompt input path ${path} is not a canonical JSON Pointer`);
      }
    }
    if (seen.has(path)) throw new TypeError(`Prompt input path ${path} is duplicated`);
    seen.add(path);
    canonical.push(path);
  }
  return Object.freeze(canonical.sort(compareText));
}

export function validatePromptTemplateInputs(
  parsed: ParsedPromptTemplate,
  declaredPaths: readonly string[],
): readonly string[] {
  const canonical = canonicalPromptInputPaths(declaredPaths);
  if (
    canonical.length !== parsed.inputPaths.length ||
    canonical.some((path, index) => path !== parsed.inputPaths[index])
  ) {
    throw new TypeError("Declared prompt inputPaths must exactly match template input paths");
  }
  return canonical;
}

function escapePointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

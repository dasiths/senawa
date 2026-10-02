import {
  type CanonicalValue,
  canonicalValue,
  type Sha256,
  type Sha256Digest,
} from "@senawa/kernel";
import {
  type ConfigurationResourceKind,
  ConfigurationResourceReadError,
  type ConfigurationResourceReader,
  type ConfigurationTextResourceSource,
} from "./contracts.js";

export const CONFIGURATION_RESOURCE_LIMITS = Object.freeze({
  maxPathBytes: 1_024,
  maxPathSegments: 32,
  maxSegmentBytes: 128,
  maxPromptBytes: 32 * 1_024,
  maxSchemaBytes: 256 * 1_024,
  maxAggregateBytes: 8 * 1_024 * 1_024,
  maxPromptResources: 64,
  maxSchemaResources: 256,
});

export class ConfigurationResourceValidationError extends Error {
  readonly code:
    | "invalid-resource-path"
    | "resource-read-failed"
    | "invalid-resource-utf8"
    | "duplicate-json-member"
    | "invalid-schema";

  constructor(
    code: ConfigurationResourceValidationError["code"],
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ConfigurationResourceValidationError";
    this.code = code;
  }
}

export function validateConfigurationResourcePath(
  kind: ConfigurationResourceKind,
  path: string,
): string {
  if (typeof path !== "string" || path.length === 0) return invalidPath("Path is empty");
  const bytes = new TextEncoder().encode(path);
  if (bytes.byteLength > CONFIGURATION_RESOURCE_LIMITS.maxPathBytes) {
    return invalidPath("Path exceeds its UTF-8 byte limit");
  }
  if (
    path.includes("\0") ||
    path.includes("\\") ||
    path.includes(":") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("%") ||
    path.startsWith("/") ||
    path.endsWith("/")
  ) {
    return invalidPath("Path contains a forbidden character or prefix");
  }
  const segments = path.split("/");
  if (segments.length > CONFIGURATION_RESOURCE_LIMITS.maxPathSegments) {
    return invalidPath("Path has too many segments");
  }
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment) ||
      new TextEncoder().encode(segment).byteLength > CONFIGURATION_RESOURCE_LIMITS.maxSegmentBytes
    ) {
      return invalidPath("Path contains an invalid segment");
    }
  }
  const validKindPath =
    kind === "prompt"
      ? path.startsWith("prompts/") && path.endsWith(".md")
      : path.startsWith("schemas/") && path.endsWith(".schema.json");
  if (!validKindPath) return invalidPath(`Path does not match the ${kind} resource namespace`);
  return path;
}

export async function readConfigurationTextResource(
  reader: ConfigurationResourceReader,
  kind: ConfigurationResourceKind,
  path: string,
  sha256: Sha256,
): Promise<ConfigurationTextResourceSource> {
  const normalizedPath = validateConfigurationResourcePath(kind, path);
  const maxBytes =
    kind === "prompt"
      ? CONFIGURATION_RESOURCE_LIMITS.maxPromptBytes
      : CONFIGURATION_RESOURCE_LIMITS.maxSchemaBytes;
  let returned: Uint8Array;
  try {
    returned = await reader.read({ kind, path: normalizedPath, maxBytes });
  } catch (error) {
    const detail =
      error instanceof ConfigurationResourceReadError ? error.code : ("read-failed" as const);
    throw new ConfigurationResourceValidationError(
      "resource-read-failed",
      `${kind} resource could not be read (${detail})`,
      detail,
    );
  }
  if (!(returned instanceof Uint8Array)) {
    throw new ConfigurationResourceValidationError(
      "resource-read-failed",
      `${kind} resource reader returned an invalid byte value`,
      "read-failed",
    );
  }
  const bytes = Uint8Array.from(returned);
  if (bytes.byteLength > maxBytes) {
    throw new ConfigurationResourceValidationError(
      "resource-read-failed",
      `${kind} resource exceeds its byte limit`,
      "too-large",
    );
  }
  let utf8: string;
  try {
    utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ConfigurationResourceValidationError(
      "invalid-resource-utf8",
      `${kind} resource must be valid round-trippable UTF-8`,
    );
  }
  if (utf8.includes("\0") || !equalBytes(new TextEncoder().encode(utf8), bytes)) {
    throw new ConfigurationResourceValidationError(
      "invalid-resource-utf8",
      `${kind} resource must be NUL-free round-trippable UTF-8`,
    );
  }
  const contentDigest = sha256.digest(bytes);
  if (!/^[0-9a-f]{64}$/u.test(contentDigest)) {
    throw new TypeError("SHA-256 implementations must return lowercase hexadecimal digests");
  }
  return canonicalValue({
    path: normalizedPath,
    mediaType:
      kind === "prompt" ? "text/markdown; charset=utf-8" : "application/schema+json; charset=utf-8",
    byteLength: bytes.byteLength,
    contentDigest: contentDigest as Sha256Digest,
    utf8,
  }) as unknown as ConfigurationTextResourceSource;
}

export interface StrictJsonResult {
  readonly value: CanonicalValue;
}

export function parseStrictJsonResource(text: string): StrictJsonResult {
  const parser = new StrictJsonParser(text);
  const value = parser.parse();
  try {
    return Object.freeze({ value: canonicalValue(value) });
  } catch {
    throw new ConfigurationResourceValidationError(
      "invalid-schema",
      "Schema resource must contain one canonical JSON value",
    );
  }
}

class StrictJsonParser {
  #offset = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    this.#space();
    const value = this.#value("");
    this.#space();
    if (this.#offset !== this.text.length) this.#invalid("Schema JSON has trailing content");
    return value;
  }

  #value(pointer: string): unknown {
    const character = this.text[this.#offset];
    if (character === "{") return this.#object(pointer);
    if (character === "[") return this.#array(pointer);
    if (character === '"') return this.#string();
    for (const [literal, value] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (this.text.startsWith(literal, this.#offset)) {
        this.#offset += literal.length;
        return value;
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.text.slice(this.#offset),
    )?.[0];
    if (number !== undefined) {
      this.#offset += number.length;
      const value = Number(number);
      if (!Number.isFinite(value)) this.#invalid("Schema JSON number is not finite");
      return value;
    }
    return this.#invalid("Schema resource is not valid JSON");
  }

  #object(pointer: string): Record<string, unknown> {
    this.#offset += 1;
    this.#space();
    const result: Record<string, unknown> = {};
    const seen = new Set<string>();
    if (this.text[this.#offset] === "}") {
      this.#offset += 1;
      return result;
    }
    for (;;) {
      if (this.text[this.#offset] !== '"') this.#invalid("Schema object member must be a string");
      const key = this.#string();
      const memberPointer = `${pointer}/${escapePointer(key)}`;
      if (seen.has(key)) {
        throw new ConfigurationResourceValidationError(
          "duplicate-json-member",
          `Schema JSON contains duplicate member at ${memberPointer}`,
          memberPointer,
        );
      }
      seen.add(key);
      this.#space();
      if (this.text[this.#offset] !== ":") this.#invalid("Schema object member is missing a colon");
      this.#offset += 1;
      this.#space();
      result[key] = this.#value(memberPointer);
      this.#space();
      if (this.text[this.#offset] === "}") {
        this.#offset += 1;
        return result;
      }
      if (this.text[this.#offset] !== ",") this.#invalid("Schema object is not terminated");
      this.#offset += 1;
      this.#space();
    }
  }

  #array(pointer: string): unknown[] {
    this.#offset += 1;
    this.#space();
    const result: unknown[] = [];
    if (this.text[this.#offset] === "]") {
      this.#offset += 1;
      return result;
    }
    for (;;) {
      result.push(this.#value(`${pointer}/${result.length}`));
      this.#space();
      if (this.text[this.#offset] === "]") {
        this.#offset += 1;
        return result;
      }
      if (this.text[this.#offset] !== ",") this.#invalid("Schema array is not terminated");
      this.#offset += 1;
      this.#space();
    }
  }

  #string(): string {
    const start = this.#offset;
    this.#offset += 1;
    let escaped = false;
    while (this.#offset < this.text.length) {
      const character = this.text[this.#offset];
      this.#offset += 1;
      if (!escaped && character === '"') {
        try {
          return JSON.parse(this.text.slice(start, this.#offset)) as string;
        } catch {
          return this.#invalid("Schema JSON string is invalid");
        }
      }
      if (!escaped && character !== undefined && character.charCodeAt(0) < 0x20) {
        return this.#invalid("Schema JSON string contains a control character");
      }
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
    }
    return this.#invalid("Schema JSON string is not terminated");
  }

  #space(): void {
    while ([" ", "\t", "\n", "\r"].includes(this.text[this.#offset] ?? "")) {
      this.#offset += 1;
    }
  }

  #invalid(message: string): never {
    throw new ConfigurationResourceValidationError("invalid-schema", message);
  }
}

function invalidPath(message: string): never {
  throw new ConfigurationResourceValidationError("invalid-resource-path", message);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

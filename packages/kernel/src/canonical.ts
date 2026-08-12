declare const canonicalValueBrand: unique symbol;
declare const sha256DigestBrand: unique symbol;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type CanonicalValue = JsonValue & {
  readonly [canonicalValueBrand]: true;
};

export type Sha256Digest = string & {
  readonly [sha256DigestBrand]: true;
};

export interface Sha256 {
  digest(bytes: Uint8Array): string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INVALID_JSON_VALUE = Symbol("invalid-json-value");

type SnapshotResult = JsonValue | typeof INVALID_JSON_VALUE;

export function isJsonValue(value: unknown): value is JsonValue {
  try {
    return snapshotJsonValue(value, new Set<object>()) !== INVALID_JSON_VALUE;
  } catch {
    return false;
  }
}

function snapshotJsonValue(value: unknown, ancestors: Set<object>): SnapshotResult {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : INVALID_JSON_VALUE;
  }

  if (typeof value !== "object") {
    return INVALID_JSON_VALUE;
  }

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return INVALID_JSON_VALUE;
  }

  if (ancestors.has(value)) {
    return INVALID_JSON_VALUE;
  }

  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Array.isArray(value)
      ? snapshotJsonArray(descriptors, ancestors)
      : snapshotJsonObject(descriptors, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function snapshotJsonArray(
  descriptors: PropertyDescriptorMap,
  ancestors: Set<object>,
): SnapshotResult {
  const ownKeys = Reflect.ownKeys(descriptors);
  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined ||
    !isDataDescriptor(lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    ownKeys.length !== lengthDescriptor.value + 1
  ) {
    return INVALID_JSON_VALUE;
  }

  const result: JsonValue[] = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !isDataDescriptor(descriptor)) {
      return INVALID_JSON_VALUE;
    }
    const item = snapshotJsonValue(descriptor.value, ancestors);
    if (item === INVALID_JSON_VALUE) {
      return INVALID_JSON_VALUE;
    }
    result.push(item);
  }

  if (ownKeys.some((key) => typeof key !== "string" || (key !== "length" && !(key in result)))) {
    return INVALID_JSON_VALUE;
  }
  return Object.freeze(result);
}

function snapshotJsonObject(
  descriptors: PropertyDescriptorMap,
  ancestors: Set<object>,
): SnapshotResult {
  const result: Record<string, JsonValue> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") {
      return INVALID_JSON_VALUE;
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !isDataDescriptor(descriptor)) {
      return INVALID_JSON_VALUE;
    }
    const item = snapshotJsonValue(descriptor.value, ancestors);
    if (item === INVALID_JSON_VALUE) {
      return INVALID_JSON_VALUE;
    }
    result[key] = item;
  }
  return Object.freeze(result);
}

function isDataDescriptor(
  descriptor: PropertyDescriptor,
): descriptor is PropertyDescriptor & { readonly value: unknown } {
  return Object.hasOwn(descriptor, "value") && !Object.hasOwn(descriptor, "get");
}

export function canonicalValue(value: unknown): CanonicalValue {
  let accepted: SnapshotResult = INVALID_JSON_VALUE;
  try {
    accepted = snapshotJsonValue(value, new Set<object>());
  } catch {
    accepted = INVALID_JSON_VALUE;
  }
  if (accepted === INVALID_JSON_VALUE) {
    throw new TypeError("Canonical values must contain only finite JSON values and plain objects");
  }

  return accepted as CanonicalValue;
}

export function canonicalSerialize(value: CanonicalValue): string {
  return serialize(value);
}

export function canonicalBytes(value: CanonicalValue): Uint8Array {
  return encodeUtf8(canonicalSerialize(value));
}

export function canonicalDigest(value: CanonicalValue, sha256: Sha256): Sha256Digest {
  const digest = sha256.digest(canonicalBytes(value));
  if (!SHA256_PATTERN.test(digest)) {
    throw new TypeError("SHA-256 implementations must return 64 lowercase hexadecimal characters");
  }

  return digest as Sha256Digest;
}

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function sha256Digest(value: string): Sha256Digest {
  if (!isSha256Digest(value)) {
    throw new TypeError("SHA-256 digests must contain 64 lowercase hexadecimal characters");
  }

  return value;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function serialize(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (isJsonArray(value)) {
    return `[${value.map(serialize).join(",")}]`;
  }

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(value[key] as JsonValue)}`);
  return `{${entries.join(",")}}`;
}

function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];

  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }

  return Uint8Array.from(bytes);
}

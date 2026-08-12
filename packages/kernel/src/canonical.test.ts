import { describe, expect, it } from "vitest";
import {
  canonicalBytes,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  isJsonValue,
  type Sha256,
  sha256Digest,
} from "./canonical.js";

const pureSha256: Sha256 = { digest: sha256Hex };

describe("canonical values", () => {
  it("accepts JSON-safe values and rejects runtime-specific values", () => {
    expect(isJsonValue({ enabled: true, count: 2, values: [null, "ok"] })).toBe(true);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue({ missing: undefined })).toBe(false);
    expect(isJsonValue(new Date(0))).toBe(false);
    expect(() => canonicalValue({ value: 1n })).toThrow(TypeError);
  });

  it("rejects cycles and snapshots accepted values", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(isJsonValue(cyclic)).toBe(false);
    expect(() => canonicalValue(cyclic)).toThrow(TypeError);

    const source = { nested: { value: "before" } };
    const accepted = canonicalValue(source);
    source.nested.value = "after";
    expect(canonicalSerialize(accepted)).toBe('{"nested":{"value":"before"}}');
  });

  it("rejects sparse arrays without colliding with dense arrays", () => {
    const oneHole = Array(1);
    const leadingHole = Array(2);
    leadingHole[1] = "value";

    expect(isJsonValue(oneHole)).toBe(false);
    expect(isJsonValue(leadingHole)).toBe(false);
    expect(() => canonicalValue(oneHole)).toThrow(TypeError);
    expect(() => canonicalValue([undefined])).toThrow(TypeError);
    expect(canonicalSerialize(canonicalValue([]))).toBe("[]");
    expect(canonicalSerialize(canonicalValue([null]))).toBe("[null]");
    expect(canonicalSerialize(canonicalValue([null, null]))).toBe("[null,null]");
  });

  it("inspects property descriptors without invoking accessors", () => {
    let getterCalls = 0;
    const changingAccessor = Object.defineProperty({}, "field", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return getterCalls === 1 ? 1 : undefined;
      },
    });
    const undefinedAccessor = Object.defineProperty({}, "field", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return undefined;
      },
    });

    expect(isJsonValue(changingAccessor)).toBe(false);
    expect(() => canonicalValue(undefinedAccessor)).toThrow(TypeError);
    expect(getterCalls).toBe(0);
  });

  it("rejects symbol, non-enumerable, accessor, and custom array properties", () => {
    const symbol = Symbol("hidden");
    const symbolObject = { visible: true, [symbol]: "hidden" };
    const nonEnumerableObject = Object.defineProperty({ visible: true }, "hidden", {
      value: "hidden",
    });
    const customArray = Object.assign(["value"], { extra: true });
    const nonEnumerableArray = Object.defineProperty(["value"], "extra", { value: true });
    const symbolArray = Object.assign(["value"], { [symbol]: true });
    const accessorArray = ["value"];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });

    for (const value of [
      symbolObject,
      nonEnumerableObject,
      customArray,
      nonEnumerableArray,
      symbolArray,
      accessorArray,
    ]) {
      expect(isJsonValue(value)).toBe(false);
      expect(() => canonicalValue(value)).toThrow(TypeError);
    }
  });
});

describe("canonical serialization", () => {
  it("uses a SHA-256 adapter that matches the standard abc vector", () => {
    expect(sha256Hex(Uint8Array.from([0x61, 0x62, 0x63]))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("produces identical bytes and digests for equivalent property orders", () => {
    const first = canonicalValue({ z: 1, nested: { beta: true, alpha: "value" }, a: [3, 2, 1] });
    const second = canonicalValue({ a: [3, 2, 1], nested: { alpha: "value", beta: true }, z: 1 });

    expect(canonicalSerialize(first)).toBe(
      '{"a":[3,2,1],"nested":{"alpha":"value","beta":true},"z":1}',
    );
    expect(canonicalBytes(first)).toEqual(canonicalBytes(second));
    expect(canonicalDigest(first, pureSha256)).toBe(canonicalDigest(second, pureSha256));
  });

  it.each([
    [
      canonicalValue(null),
      "null",
      "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
    ],
    [
      canonicalValue({ hello: "world" }),
      '{"hello":"world"}',
      "93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588",
    ],
    [
      canonicalValue({ emoji: "😀", text: "café" }),
      '{"emoji":"😀","text":"café"}',
      "6d623d46adcf00bf9c4f904dbd0e3a0b1e8e1dc180c1d6ae5d9b895728511e15",
    ],
  ])("matches the golden SHA-256 vector for %s", (value, serialized, digest) => {
    expect(canonicalSerialize(value)).toBe(serialized);
    expect(canonicalDigest(value, pureSha256)).toBe(digest);
  });

  it("rejects malformed digest implementations and digest values", () => {
    expect(() => canonicalDigest(canonicalValue("value"), { digest: () => "ABC" })).toThrow(
      TypeError,
    );
    expect(() => sha256Digest("ABC")).toThrow(TypeError);
  });
});

const SHA256_CONSTANTS = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Hex(input: Uint8Array): string {
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const message = new Uint8Array(paddedLength);
  message.set(input);
  message[input.length] = 0x80;

  const bitLength = input.length * 8;
  const view = new DataView(message.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const state = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15] as number;
      const previous2 = words[index - 2] as number;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] =
        ((words[index - 16] as number) + sigma0 + (words[index - 7] as number) + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state as unknown as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h + sum1 + choice + (SHA256_CONSTANTS[index] as number) + (words[index] as number)) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      [a, b, c, d, e, f, g, h] = [
        (temporary1 + temporary2) >>> 0,
        a,
        b,
        c,
        (d + temporary1) >>> 0,
        e,
        f,
        g,
      ];
    }

    const compressed = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < state.length; index += 1) {
      state[index] = ((state[index] as number) + (compressed[index] as number)) >>> 0;
    }
  }

  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

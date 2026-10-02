import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

import type { ControlPlaneClock, ControlPlaneRandom } from "./authority.js";

export class VirtualClock implements ControlPlaneClock {
  #currentMs: number;

  constructor(initialTime: string) {
    this.#currentMs = Date.parse(initialTime);
    if (!Number.isFinite(this.#currentMs))
      throw new Error("virtual clock requires an ISO timestamp");
  }

  now(): string {
    return new Date(this.#currentMs).toISOString();
  }

  advance(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("virtual clock advance must be a non-negative safe integer");
    }
    this.#currentMs += milliseconds;
  }
}

export class DeterministicRandom implements ControlPlaneRandom {
  readonly #prefix: string;
  #counter = 0;

  constructor(prefix = "fixture") {
    this.#prefix = prefix;
  }

  next(kind: string): string {
    this.#counter += 1;
    return `${this.#prefix}-${kind}-${String(this.#counter).padStart(4, "0")}`;
  }
}

export interface Ed25519FixtureKeyPair {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export function createEd25519FixtureKeyPair(keyId: string, seedHex: string): Ed25519FixtureKeyPair {
  if (!/^[0-9a-f]{64}$/u.test(seedHex)) {
    throw new Error("Ed25519 fixture seed must contain exactly 32 lowercase hexadecimal bytes");
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(seedHex, "hex"),
    ]),
    format: "der",
    type: "pkcs8",
  });
  return Object.freeze({ keyId, privateKey, publicKey: createPublicKey(privateKey) });
}

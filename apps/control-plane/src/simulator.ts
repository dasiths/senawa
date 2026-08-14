import { createHash } from "node:crypto";
import {
  encodeRemoteCommandEnvelope,
  type RemoteCommandEnvelope,
  type RemoteReceiptChain,
} from "@senawa/protocol";

import type { AuthorityRefusal, ControlPlaneRandom, ReferenceControlPlane } from "./authority.js";
import type { VirtualClock } from "./fixtures.js";

export interface SimulatedDeliveryFrame {
  readonly frameId: string;
  readonly bindingId: string;
  readonly sequence: number;
  readonly availableAt: string;
  readonly envelopeDigest: string;
}

export interface SimulatedDeliveryResult {
  readonly frame: SimulatedDeliveryFrame;
  readonly envelope: RemoteCommandEnvelope;
  readonly result: RemoteReceiptChain | AuthorityRefusal;
}

interface MutableDeliveryFrame {
  readonly frameId: string;
  readonly bindingId: string;
  readonly sequence: number;
  availableAtMs: number;
  readonly envelopeDigest: string;
}

export class DeterministicControlPlaneSimulator {
  readonly #authority: ReferenceControlPlane;
  readonly #clock: VirtualClock;
  readonly #random: ControlPlaneRandom;
  readonly #queue: MutableDeliveryFrame[] = [];
  readonly #scheduled = new Set<string>();
  readonly #partitions = new Set<string>();
  readonly #revocationEpochs = new Map<string, number>();
  readonly #revoked = new Set<string>();

  constructor(input: {
    readonly authority: ReferenceControlPlane;
    readonly clock: VirtualClock;
    readonly random: ControlPlaneRandom;
  }) {
    this.#authority = input.authority;
    this.#clock = input.clock;
    this.#random = input.random;
  }

  enqueue(bindingId: string, afterSequence = 0): readonly SimulatedDeliveryFrame[] {
    if (this.#revoked.has(bindingId)) return Object.freeze([]);
    const added: SimulatedDeliveryFrame[] = [];
    for (const envelope of this.#authority.envelopes(bindingId)) {
      if (envelope.sequence <= afterSequence) continue;
      const canonicalId = `${bindingId}:${envelope.sequence}`;
      if (this.#scheduled.has(canonicalId)) continue;
      this.#scheduled.add(canonicalId);
      const frame = this.#newFrame(bindingId, envelope);
      this.#queue.push(frame);
      added.push(snapshotFrame(frame));
    }
    return Object.freeze(added);
  }

  duplicate(frameId: string): SimulatedDeliveryFrame {
    const source = this.#requiredFrame(frameId);
    const duplicate: MutableDeliveryFrame = {
      ...source,
      frameId: this.#random.next("delivery"),
    };
    const index = this.#queue.indexOf(source);
    this.#queue.splice(index + 1, 0, duplicate);
    return snapshotFrame(duplicate);
  }

  delay(frameId: string, milliseconds: number): SimulatedDeliveryFrame {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error("delivery delay must be a non-negative safe integer");
    }
    const frame = this.#requiredFrame(frameId);
    frame.availableAtMs += milliseconds;
    return snapshotFrame(frame);
  }

  reorder(frameIds: readonly string[]): void {
    if (frameIds.length !== this.#queue.length || new Set(frameIds).size !== frameIds.length) {
      throw new Error("reorder must name every queued frame exactly once");
    }
    const byId = new Map(this.#queue.map((frame) => [frame.frameId, frame]));
    const reordered = frameIds.map((frameId) => {
      const frame = byId.get(frameId);
      if (frame === undefined) throw new Error("reorder contains an unknown frame");
      return frame;
    });
    this.#queue.splice(0, this.#queue.length, ...reordered);
  }

  drop(frameId: string): void {
    const frame = this.#requiredFrame(frameId);
    this.#queue.splice(this.#queue.indexOf(frame), 1);
    this.#releaseCanonicalFrame(frame);
  }

  partition(bindingId: string): void {
    this.#partitions.add(bindingId);
  }

  reconnect(bindingId: string): void {
    this.#partitions.delete(bindingId);
  }

  isPartitioned(bindingId: string): boolean {
    return this.#partitions.has(bindingId);
  }

  registerBinding(bindingId: string, revocationEpoch: number): void {
    if (!Number.isSafeInteger(revocationEpoch) || revocationEpoch < 0) {
      throw new Error("revocation epoch must be a non-negative safe integer");
    }
    const current = this.#revocationEpochs.get(bindingId);
    if (current !== undefined && current !== revocationEpoch) {
      throw new Error("binding revocation epoch is already registered");
    }
    this.#revocationEpochs.set(bindingId, revocationEpoch);
  }

  revocationEpoch(bindingId: string): number {
    const epoch = this.#revocationEpochs.get(bindingId);
    if (epoch === undefined) throw new Error("binding revocation epoch is not registered");
    return epoch;
  }

  revoke(bindingId: string): void {
    const current = this.revocationEpoch(bindingId);
    this.#authority.revoke(bindingId);
    this.#revocationEpochs.set(bindingId, current + 1);
    this.#revoked.add(bindingId);
  }

  expire(milliseconds: number): void {
    this.#clock.advance(milliseconds);
  }

  poll(bindingId: string, limit = 64, afterSequence = 0): readonly SimulatedDeliveryResult[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new Error("poll limit must be between 1 and 256");
    }
    if (this.#partitions.has(bindingId)) return Object.freeze([]);
    const results: SimulatedDeliveryResult[] = [];
    for (let index = 0; index < this.#queue.length && results.length < limit; ) {
      const frame = this.#queue[index];
      if (frame === undefined) break;
      if (frame.bindingId === bindingId && frame.sequence <= afterSequence) {
        this.#queue.splice(index, 1);
        this.#releaseCanonicalFrame(frame);
        continue;
      }
      if (frame.bindingId !== bindingId || frame.availableAtMs > Date.parse(this.#clock.now())) {
        index += 1;
        continue;
      }
      this.#queue.splice(index, 1);
      this.#releaseCanonicalFrame(frame);
      const envelope = this.#authority.envelopes(bindingId)[frame.sequence - 1];
      if (envelope === undefined) throw new Error("scheduled envelope is no longer canonical");
      results.push(
        Object.freeze({
          frame: snapshotFrame(frame),
          envelope,
          result: this.#authority.recordDelivery(bindingId, frame.sequence),
        }),
      );
    }
    return Object.freeze(results);
  }

  pending(): readonly SimulatedDeliveryFrame[] {
    return Object.freeze(this.#queue.map(snapshotFrame));
  }

  #newFrame(bindingId: string, envelope: RemoteCommandEnvelope): MutableDeliveryFrame {
    return {
      frameId: this.#random.next("delivery"),
      bindingId,
      sequence: envelope.sequence,
      availableAtMs: Date.parse(this.#clock.now()),
      envelopeDigest: createHash("sha256")
        .update(encodeRemoteCommandEnvelope(envelope), "utf8")
        .digest("hex"),
    };
  }

  #requiredFrame(frameId: string): MutableDeliveryFrame {
    const frame = this.#queue.find((candidate) => candidate.frameId === frameId);
    if (frame === undefined) throw new Error("delivery frame is not queued");
    return frame;
  }

  #releaseCanonicalFrame(frame: MutableDeliveryFrame): void {
    if (
      !this.#queue.some(
        (candidate) =>
          candidate.bindingId === frame.bindingId && candidate.sequence === frame.sequence,
      )
    ) {
      this.#scheduled.delete(`${frame.bindingId}:${frame.sequence}`);
    }
  }
}

function snapshotFrame(frame: MutableDeliveryFrame): SimulatedDeliveryFrame {
  return Object.freeze({
    frameId: frame.frameId,
    bindingId: frame.bindingId,
    sequence: frame.sequence,
    availableAt: new Date(frame.availableAtMs).toISOString(),
    envelopeDigest: frame.envelopeDigest,
  });
}

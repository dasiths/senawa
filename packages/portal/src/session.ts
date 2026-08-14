import type { PortalSessionDescriptor } from "@senawa/protocol";
import type { PersistedPortalSession } from "./pending.js";

export type PortalSessionAccess =
  | { readonly type: "issue-csrf" }
  | { readonly type: "read-write"; readonly csrfToken: string }
  | { readonly type: "read-only" };

export function sessionAccess(
  descriptor: PortalSessionDescriptor,
  persisted: PersistedPortalSession | undefined,
  now: number,
): PortalSessionAccess {
  if (descriptor.csrfMode === "available") return Object.freeze({ type: "issue-csrf" });
  if (
    persisted !== undefined &&
    persisted.expiresAt === descriptor.expiresAt &&
    Date.parse(persisted.expiresAt) > now
  ) {
    return Object.freeze({ type: "read-write", csrfToken: persisted.csrfToken });
  }
  return Object.freeze({ type: "read-only" });
}

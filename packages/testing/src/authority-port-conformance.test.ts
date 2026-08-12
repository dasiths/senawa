import {
  createRoleAuthorizationPolicy,
  InMemoryAuthority,
  RuntimeCommandService,
  type RuntimeDependencies,
} from "@senawa/runtime";
import {
  type RuntimeAuthorityConformanceHarness,
  registerRuntimeAuthorityConformance,
} from "./authority-conformance.js";
import { deterministicSha256 } from "./index.js";

const dependencies: RuntimeDependencies = {
  sha256: deterministicSha256,
  authorization: createRoleAuthorizationPolicy(
    [
      "instantiate-run",
      "accept-graph-revision",
      "submit-completion",
      "evaluate-gate",
      "record-authority-decision",
      "close-phase",
    ].map((intent) => ({
      intent: intent as Parameters<typeof createRoleAuthorizationPolicy>[0][number]["intent"],
      roles: ["release-manager"],
    })),
  ),
};

registerRuntimeAuthorityConformance("in-memory", dependencies, (runtimeDependencies) =>
  createHarness(runtimeDependencies, new InMemoryAuthority()),
);

function createHarness(
  runtimeDependencies: RuntimeDependencies,
  authority: InMemoryAuthority,
): RuntimeAuthorityConformanceHarness {
  const service = new RuntimeCommandService(runtimeDependencies, authority);
  return {
    service,
    canonicalJson: () => authority.toCanonicalJson(),
    reopen: () =>
      createHarness(
        runtimeDependencies,
        InMemoryAuthority.fromCanonicalJson(authority.toCanonicalJson(), runtimeDependencies),
      ),
    dispose() {},
  };
}

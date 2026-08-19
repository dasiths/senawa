import { describe, expect, it } from "vitest";
import { parsePortalHash } from "./router.js";

describe("hostile route values", () => {
  it("rejects active-content and traversal-shaped route identities", () => {
    expect(parsePortalHash("#/runs/%3Cscript%3E/run_one/graph")).toEqual({ name: "graph" });
    expect(parsePortalHash("#/runs/../run_one/artifacts")).toEqual({ name: "graph" });
  });
});

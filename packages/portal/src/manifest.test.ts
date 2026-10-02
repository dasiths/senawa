import { describe, expect, it } from "vitest";
import { sha256 } from "./pending.js";

describe("browser content digest", () => {
  it("computes lowercase SHA-256 with Web Crypto", async () => {
    await expect(sha256("senawa portal")).resolves.toBe(
      "cddb2f4f16a95b4ae69c07ebccb5bc7391947b163937e0b18a3d8bb8fb42a6a6",
    );
  });
});

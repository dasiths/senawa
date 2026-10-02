import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { provider: "v8" },
    include: ["{apps,packages}/**/*.test.ts"],
    // Much of this suite spawns real processes, opens real databases, and runs
    // real sensors. Under parallel load those exceed five seconds while passing
    // alone, which is the shape of a flake that gets ignored until it fails in
    // CI.
    testTimeout: 30_000,
  },
});

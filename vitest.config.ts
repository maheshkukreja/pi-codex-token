import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Coverage is measured ONLY on the deterministic surface. The single live
      // boundary (real fetch / SDK call when deps are not injected) is exercised
      // by test/smoke.test.ts, which is excluded here.
      include: ["src/**/*.ts"],
      exclude: ["test/smoke.test.ts"],
      reporter: ["text", "html"],
      thresholds: {
        lines: 99,
        branches: 99,
        functions: 99,
        statements: 99,
      },
    },
  },
});

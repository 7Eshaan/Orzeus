import { defaultClientConditions, defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

/** Resolve workspace packages to their TypeScript sources so tests never need a build first. */
const sourceCondition = "@orzeus/source";

export default defineConfig({
  resolve: { conditions: [sourceCondition, ...defaultClientConditions] },
  ssr: { resolve: { conditions: [sourceCondition, ...defaultServerConditions] } },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "services/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.{ts,tsx}",
    ],
    environment: "node",
    passWithNoTests: false,
    restoreMocks: true,
    // Engine tests drive real git repositories and run alongside the chaos test, which keeps every
    // core busy; 1-3 s on an idle machine can pass 5 s under that load.
    testTimeout: 20_000,
  },
});

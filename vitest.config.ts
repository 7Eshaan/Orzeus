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
  },
});

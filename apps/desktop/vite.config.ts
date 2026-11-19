import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

/**
 * Tauri expects a fixed dev port and serves the built files from ../dist. Workspace packages
 * resolve to their TypeScript sources through the "@orzeus/source" export condition.
 */
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: { conditions: ["@orzeus/source", ...defaultClientConditions] },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "safari17",
    sourcemap: true,
  },
});

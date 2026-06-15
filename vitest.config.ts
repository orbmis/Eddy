import { defineConfig } from "vitest/config";

// Fork tests spin up an anvil Base fork and drive real on-chain bytecode, so
// they need a generous timeout and must run serially (single shared fork).
export default defineConfig({
  // Inline (empty) PostCSS config so Vite does not search parent directories
  // and accidentally load an unrelated postcss.config from outside the project.
  css: { postcss: { plugins: [] } },
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

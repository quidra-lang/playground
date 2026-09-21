/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative asset paths so the same build works at the domain root and under
  // a subpath such as /playground/ on GitHub Pages.
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});

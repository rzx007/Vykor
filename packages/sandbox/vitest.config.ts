import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "__test__/e2e/**/*.test.ts"],
  },
});

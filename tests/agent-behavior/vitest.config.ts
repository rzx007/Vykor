import { mergeConfig } from "vitest/config";
import root from "../../vitest.config.js";

export default mergeConfig(root, {
  test: {
    include: ["tests/agent-behavior/**/*.test.ts"],
    testTimeout: 150_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});

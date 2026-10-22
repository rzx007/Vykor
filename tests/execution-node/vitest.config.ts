import { mergeConfig } from "vitest/config";
import root from "../../vitest.config.js";
export default mergeConfig(root, { test: { include: ["tests/execution-node/**/*.test.ts"], fileParallelism: false } });

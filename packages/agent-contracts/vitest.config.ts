import { defineConfig, mergeConfig } from "vitest/config";
import root from "../../vitest.config.js";

export default mergeConfig(root, defineConfig({ test: { include: ["src/**/*.test.ts"] } }));

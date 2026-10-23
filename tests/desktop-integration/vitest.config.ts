import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import desktopConfig from "../../apps/desktop/vitest.config";

const desktop = new URL("../../apps/desktop/", import.meta.url);

export default mergeConfig(desktopConfig, {
  root: fileURLToPath(new URL("../../", import.meta.url)),
  resolve: {
    alias: {
      react: fileURLToPath(new URL("node_modules/react", desktop)),
      "react-dom": fileURLToPath(new URL("node_modules/react-dom", desktop)),
    },
  },
  test: {
    include: ["tests/desktop-integration/__test__/**/*.test.ts"],
    fileParallelism: false,
  },
});

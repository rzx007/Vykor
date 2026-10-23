import { expect, it } from "vitest";
import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { OFFICE_ASSETS } from "../office-engine.mjs";

it.each(["development", "packaged"])(
  "finds the Office binary after bundling in Electron %s mode",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "office-bundle-path-"));
    try {
      const appRoot = join(root, "desktop"),
        main = join(appRoot, "out/main/engine.mjs");
      const resourceRoot =
        mode === "development" ? join(appRoot, "out") : join(root, "resources");
      const asset = OFFICE_ASSETS[process.platform + "-" + process.arch]![0];
      const binary = join(resourceRoot, "office-engine", asset);
      await mkdir(join(appRoot, "out/main"), { recursive: true });
      await mkdir(join(resourceRoot, "office-engine"), { recursive: true });
      await copyFile(resolve("src/office/office-engine.mjs"), main);
      await writeFile(binary, "path lookup fixture");
      const code = `process.argv[1]=${JSON.stringify(appRoot)};process.resourcesPath=${JSON.stringify(mode === "packaged" ? resourceRoot : join(root, "electron/resources"))};const {officeBinaryPath}=await import(${JSON.stringify(pathToFileURL(main).href)});console.log(await officeBinaryPath());`;
      const env = { ...process.env };
      delete env.VYKOR_OFFICECLI_PATH;
      expect(
        execFileSync(process.execPath, ["--input-type=module", "-e", code], {
          env,
          encoding: "utf8",
          timeout: 10000,
          windowsHide: true,
        }).trim(),
      ).toBe(binary);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

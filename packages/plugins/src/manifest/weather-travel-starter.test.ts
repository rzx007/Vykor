import { mkdtemp, readFile, mkdir, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { validateNativePlugin } from "./validate.js";

const distribution = fileURLToPath(new URL("../../../../skills/create-plugin/", import.meta.url));
const filter = (path: string) => !relative(distribution, path).split(/[\\/]/).some(part => ["node_modules", "dist"].includes(part));

it.each(["native", "mcp"])("creates and packages the %s backend from an independently copied Skill and validates actual host admission", async backend => {
  const temporary = await mkdtemp(join(tmpdir(), "weather-starter-distribution-"));
  try {
    const skill = join(temporary, "create-plugin");
    await cp(distribution, skill, { recursive: true, filter });
    const { createPlugin } = await import(/* @vite-ignore */ pathToFileURL(join(skill, "scripts/create-plugin.mjs")).href);
      const root = join(temporary, `${backend}-journey`);
      await createPlugin({ dir: root, id: `test.${backend}-journey`, name: `${backend}-journey`, displayName: "我的天气行程", backend });
      const npm = spawnSync("npm", ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
      expect(npm.status, npm.stderr).toBe(0);
      for (const script of ["build", "validate", "pack"]) {
        const command = spawnSync(process.execPath, [join(root, `scripts/${script}.mjs`)], { cwd: temporary, encoding: "utf8" });
        expect(command.status, command.stdout + command.stderr).toBe(0);
      }
      const tested = spawnSync("npm", ["test"], { cwd: root, encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, WEATHER_TEST_ALL_BACKENDS: "0" } });
      expect(tested.status, tested.stdout + tested.stderr).toBe(0);
      const validation = await validateNativePlugin(root);
      expect(validation.status, JSON.stringify(validation.diagnostics)).toBe("valid");
      const manifest = JSON.parse(await readFile(join(root, ".vykor-plugin/plugin.json"), "utf8"));
      expect(manifest.id).toBe(`test.${backend}-journey`);
      expect(manifest.displayName).toBe("我的天气行程");
      const html = await readFile(join(root, "dist/ui/panel.html"), "utf8");
      expect(html).not.toMatch(/<(?:script|link|iframe)\b[^>]*(?:src|href)\s*=/i);
      const { default: JSZip } = await import(/* @vite-ignore */ pathToFileURL(join(root, "node_modules/jszip/lib/index.js")).href);
      const zip = await JSZip.loadAsync(await readFile(join(root, `dist/${backend}-journey-1.0.0.zip`)));
      expect(Object.keys(zip.files).some(path => /node_modules|\.sqlite|\.env|tests\//.test(path))).toBe(false);
      expect(zip.file(`${backend}-journey/skills/weather/SKILL.md`)).not.toBeNull();
      const packedManifest = JSON.parse(await zip.file(`${backend}-journey/.vykor-plugin/plugin.json`)!.async("string"));
      expect(packedManifest).toEqual(manifest);
      const source = backend === "native" ? "dist/native/data.mjs" : "dist/server.mjs";
      expect(zip.file(`${backend}-journey/${source}`)).not.toBeNull();
      // A generated install must run without this repository or author dependencies.
      const installed = join(temporary, `${backend}-installed`);
      await mkdir(installed);
      for (const file of Object.values(zip.files) as Array<{ dir: boolean; name: string; async(type: "nodebuffer"): Promise<Buffer> }>) {
        if (file.dir) continue;
        const relative = file.name.slice(`${backend}-journey/`.length);
        const { mkdir: makeDir, writeFile } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        await makeDir(dirname(join(installed, relative)), { recursive: true });
        await writeFile(join(installed, relative), await file.async("nodebuffer"));
      }
      expect((await validateNativePlugin(installed)).status).toBe("valid");
      if (backend === "native") {
        const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
          const { registerTools } = await import(${JSON.stringify(pathToFileURL(join(installed, source)).href)});
          const tools = registerTools({ plugin: { id: ${JSON.stringify(manifest.id)}, root: ${JSON.stringify(installed)}, dataDir: ${JSON.stringify(join(temporary, "data"))} } });
          const read = tools.find(tool => tool.name.endsWith('ReadPlan'));
          const result = await read.invoke({}, { plugin: { id: ${JSON.stringify(manifest.id)}, root: ${JSON.stringify(installed)}, dataDir: ${JSON.stringify(join(temporary, "data"))} }, sessionId: 'isolated-session', cwd: ${JSON.stringify(temporary)}, signal: new AbortController().signal });
          if (result.isError || result.metadata.appData.document.id !== 'trip') throw Error(JSON.stringify(result));
        `], { cwd: temporary, encoding: "utf8" });
        expect(probe.status, probe.stderr + probe.stdout).toBe(0);
      } else {
        const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
          const { Client } = await import(${JSON.stringify(pathToFileURL(join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")).href)});
          const { StdioClientTransport } = await import(${JSON.stringify(pathToFileURL(join(root, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js")).href)});
          const transport = new StdioClientTransport({ command: process.execPath, args: [${JSON.stringify(join(installed, source))}], cwd: ${JSON.stringify(temporary)}, env: { ...process.env, VYKOR_WEATHER_DATA_DIR: ${JSON.stringify(join(temporary, "mcp-data"))}, VYKOR_WEATHER_SESSION: '${"b".repeat(64)}', VYKOR_WEATHER_WORKSPACE: ${JSON.stringify(temporary)} }, stderr: 'pipe' });
          transport.stderr?.on('data', data => process.stderr.write(data));
          const client = new Client({ name: 'installed-probe', version: '1.0.0' });
          try {
            await client.connect(transport);
            const tools = (await client.listTools()).tools;
            const read = tools.find(tool => tool.name.endsWith('ReadPlan'));
            const save = tools.find(tool => tool.name.endsWith('SavePlanDraft'));
            if (JSON.stringify(save._meta.ui.visibility) !== '["app"]') throw Error('Lost app-only visibility');
            const result = await client.callTool({ name: read.name, arguments: {} });
            if (result.isError || result.structuredContent.document.id !== 'trip') throw Error(JSON.stringify(result));
            const resources = await client.listResources();
            const ui = resources.resources.find(resource => resource.uri.startsWith('ui://'));
            const html = await client.readResource({ uri: ui.uri });
            if (!/<!doctype html>/i.test(html.contents[0].text)) throw Error('Missing packaged app resource');
          } finally { await client.close(); }
        `], { cwd: temporary, encoding: "utf8", timeout: 20_000 });
        expect(probe.status, probe.stderr + probe.stdout).toBe(0);
      }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 120_000);

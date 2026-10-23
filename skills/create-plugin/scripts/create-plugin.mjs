import { cp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

const template = fileURLToPath(new URL("../templates/weather-travel/", import.meta.url));
export async function createPlugin(options) {
  const { dir, id, name, backend = "native", version = "1.0.0" } = options;
  const displayName = options.displayName ?? "天气与出行助手";
  if (typeof dir !== "string" || !dir.trim()) throw new Error("A new project directory is required");
  if (typeof id !== "string" || id.length > 128 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(id)) throw new Error("Invalid dotted plugin id");
  if (typeof name !== "string" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Invalid plugin name");
  if (!["native", "mcp"].includes(backend)) throw new Error("Backend must be native or mcp");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Use a stable semantic version");
  if (typeof displayName !== "string" || !displayName.trim() || displayName.length > 80 || /[\r\n\x00]/.test(displayName)) throw new Error("Invalid display name");
  const root = resolve(dir);
  let exists = false;
  try { await access(root); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (exists) throw new Error(`Target directory already exists: ${root}`);
  await mkdir(dirname(root), { recursive: true });
  await mkdir(root);
  const filter = source => !relative(template, source).split(/[\\/]/).some(part => ["node_modules", "dist", ".git"].includes(part));
  for (const item of ["src", "ui", "scripts", "tests", "skills", "README.md", "LICENSE", "package.json", "package-lock.json"])
    await cp(join(template, item), join(root, item), { recursive: true, filter, errorOnExist: true, force: false });
  await cp(join(template, "adapters", backend), join(root, "adapters", backend), { recursive: true, filter });
  const toolPrefix = name.split("-").map(part => part[0].toUpperCase() + part.slice(1)).join("").slice(0, 20) + createHash("sha256").update(id).digest("hex").slice(0, 8);
  const config = { id, name, displayName: displayName.trim(), version, toolPrefix, backend };
  const json = value => JSON.stringify(value, null, 2) + "\n";
  await writeFile(join(root, "plugin.config.json"), json(config));
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  pkg.name = name; pkg.version = version;
  lock.name = name; lock.version = version; lock.packages[""].name = name; lock.packages[""].version = version;
  await writeFile(join(root, "package.json"), json(pkg));
  await writeFile(join(root, "package-lock.json"), json(lock));
  await writeFile(join(root, ".gitignore"), "node_modules/\ndist/\n*.log\n.env\n");
  const { configure } = await import(pathToFileURL(join(root, "scripts/configure.mjs")).href);
  await configure(root);
  return { root, config };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { dir: { type: "string" }, id: { type: "string" }, name: { type: "string" }, backend: { type: "string", default: "native" }, "display-name": { type: "string" }, version: { type: "string", default: "1.0.0" }, help: { type: "boolean", short: "h" } } });
  if (values.help) console.log("node create-plugin.mjs --dir ./my-weather --id example.my-weather --name my-weather --backend native|mcp [--display-name 名称] [--version 1.0.0]\nCreates a new standalone project; never installs, links, publishes or overwrites existing files.");
  else {
    const result = await createPlugin({ ...values, displayName: values["display-name"] });
    console.log(`Created ${result.root}\nNext: npm ci, npm run build, npm test, npm run validate, npm run pack`);
  }
}

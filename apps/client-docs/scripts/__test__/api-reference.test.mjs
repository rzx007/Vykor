import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { Application, ReflectionKind, TSConfigReader } from "typedoc";
import { apiReferenceOptions } from "../../config/api-options.mjs";

test("API reference documents only the published modules without exposing implementation details", async context => {
  const output = await mkdtemp(join(tmpdir(), "vykor-docs-api-"));
  context.after(async () => {
    assert.equal(dirname(output), resolve(tmpdir()));
    await rm(output, { recursive: true, force: true });
  });
  const app = await Application.bootstrapWithPlugins({
    ...apiReferenceOptions.typeDoc,
    entryPoints: apiReferenceOptions.entryPoints,
    tsconfig: apiReferenceOptions.tsconfig,
    plugin: ["typedoc-plugin-markdown"],
    outputs: [{ name: "markdown", path: output }],
    logLevel: "Error",
  }, [new TSConfigReader()]);
  const project = await app.convert();
  assert.ok(project, "TypeDoc must successfully convert the published declarations");
  const modules = project.getChildrenByKind(ReflectionKind.Module);
  assert.deepEqual(modules.map(module => module.name).sort(), ["index", "service"]);

  const client = modules.find(module => module.name === "index");
  for (const name of ["VykorClient", "SessionResource", "SessionSyncController", "HttpTransport", "SseTransport"])
    assert.ok(client.getChildByName(name), `${name} must be documented in the browser entry`);
  const service = modules.find(module => module.name === "service");
  for (const name of ["Service", "discover", "ensure", "stop", "clientOptions", "ServiceEndpoint"])
    assert.ok(service.getChildByName(name), `${name} must be documented in the Node service entry`);

  const reflections = Object.values(project.reflections);
  const businessExports = new Set([
    "ApplicationClient", "WorkspaceResource", "PluginsResource", "NotesResource", "SchedulesResource",
    "NoteRecord", "ScheduledTaskRecord", "MarketplaceCatalog", "PluginAppRecord", "OfficePreview",
    "PluginAppBackendDefinition", "PluginAppConversationRequest", "ChannelStatusSnapshot", "SessionCommandHost",
  ]);
  assert.deepEqual(reflections.filter(reflection => businessExports.has(reflection.name)).map(reflection => reflection.name), []);
  assert.equal(reflections.some(reflection => reflection.flags.isPrivate || reflection.flags.isProtected), false, "Private and protected members must stay out of the API");
  assert.equal(reflections.some(reflection => reflection.sources?.length), false, "Source file paths must stay out of the API");

  await app.generateOutputs(project);
  assert.equal((await readdir(output)).includes("index.md"), true, "API landing pages must use index.md so repository README files can stay private");
  for (const module of ["index", "service"])
    assert.equal((await readdir(join(output, module))).includes("index.md"), true, `${module} needs a public module landing page`);
  assert.equal((await readdir(join(output, "index/classes"))).includes("VykorClient.md"), true, "The client class must have an API page");
  assert.equal((await readdir(join(output, "service/variables"))).includes("Service.md"), true, "The service helper must have an API page");
});

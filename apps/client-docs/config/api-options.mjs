import { fileURLToPath } from "node:url";

// TypeDoc treats entry points as globs and requires forward slashes on Windows.
export const entryPoints = [
  "../../../packages/client/dist/index.d.ts",
  "../../../packages/client/dist/service.d.ts",
].map(path => fileURLToPath(new URL(path, import.meta.url)).replaceAll("\\", "/"));

export const apiTsconfig = fileURLToPath(new URL("../tsconfig.api.json", import.meta.url));

/** @satisfies {import("typedoc").TypeDocOptions & import("typedoc-plugin-markdown").PluginOptions} */
export const typeDocOptions = {
  name: "@rzx/client",
  entryPointStrategy: "resolve",
  excludePrivate: true,
  excludeProtected: true,
  excludeInternal: true,
  disableSources: true,
  disableGit: true,
  readme: "none",
  entryFileName: "index",
};

/** @satisfies {import("starlight-typedoc").StarlightTypeDocOptions} */
export const apiReferenceOptions = {
  entryPoints,
  tsconfig: apiTsconfig,
  output: "api",
  sidebar: { label: "API 参考" },
  typeDoc: typeDocOptions,
};

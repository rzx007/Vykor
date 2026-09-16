import { z } from "zod";
import type { OpenHarnessPluginManifestV1 } from "../types.js";

const declaredPathSchema = z
  .string()
  .min(3)
  .refine((value) => value.startsWith("./"), "component path must start with ./");

const toolComponentSchema = z
  .object({
    entry: declaredPathSchema,
    runtime: z.enum(["node", "wasm"]).optional(),
    permissions: z.array(z.string().min(1)).optional(),
  })
  .strict();

const pathListSchema = z.array(declaredPathSchema).min(1);

const componentsSchema = z
  .object({
    skills: pathListSchema.optional(),
    agents: pathListSchema.optional(),
    hooks: pathListSchema.optional(),
    mcpServers: pathListSchema.optional(),
    lspServers: pathListSchema.optional(),
    tools: z.array(z.union([declaredPathSchema, toolComponentSchema])).min(1).optional(),
    workflows: pathListSchema.optional(),
    channels: pathListSchema.optional(),
    providers: pathListSchema.optional(),
    ui: pathListSchema.optional(),
    outputStyles: pathListSchema.optional(),
    themes: pathListSchema.optional(),
    monitors: pathListSchema.optional(),
    binaries: pathListSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "components must declare at least one source");

const permissionListSchema = z.array(z.string().min(1));

export const OpenHarnessPluginManifestV1Schema: z.ZodType<OpenHarnessPluginManifestV1> = z
  .object({
    $schema: z.string().url().optional(),
    schemaVersion: z.literal(1),
    id: z
      .string()
      .regex(
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/,
        "id must be a stable dotted identifier with at least two segments",
      ),
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "name must use kebab-case"),
    displayName: z.string().min(1).optional(),
    version: z.string().min(1),
    description: z.string().optional(),
    author: z
      .object({
        name: z.string().min(1),
        email: z.string().email().optional(),
        url: z.string().url().optional(),
      })
      .strict()
      .optional(),
    homepage: z.string().url().optional(),
    repository: z.string().min(1).optional(),
    license: z.string().min(1).optional(),
    keywords: z.array(z.string().min(1)).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    components: componentsSchema,
    permissions: z
      .object({
        filesystem: permissionListSchema.optional(),
        network: permissionListSchema.optional(),
        process: permissionListSchema.optional(),
        secrets: permissionListSchema.optional(),
      })
      .strict()
      .optional(),
    runtime: z
      .object({
        engine: z.enum(["node", "wasm"]),
        isolation: z.enum(["worker", "process"]),
      })
      .strict()
      .optional(),
  })
  .strict();

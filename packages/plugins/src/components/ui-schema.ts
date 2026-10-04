import { z } from "zod";
import { PLUGIN_UI_LIMITS } from "@vykor/protocol";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const text = z.string().refine(value => value.trim().length > 0
  && Array.from(value).length <= PLUGIN_UI_LIMITS.titleCodePoints);
const action = z.object({
  id,
  label: text,
  tool: z.string().min(1).refine(value => value === value.trim()),
  completion: z.enum(["keep-open", "resolve"]),
}).strict();
const component = z.object({
  id,
  title: text,
  entry: z.string().refine(value => value.startsWith("./")),
  surfaces: z.array(z.enum(["tool-result", "session-sidebar"]))
    .min(1).max(2).refine(values => new Set(values).size === values.length),
  actions: z.array(action).max(PLUGIN_UI_LIMITS.actionsPerComponent)
    .refine(values => new Set(values.map(value => value.id)).size === values.length),
}).strict();

export const PluginUiManifestV1Schema = z.object({
  schemaVersion: z.literal(1),
  components: z.array(component).min(1).max(PLUGIN_UI_LIMITS.componentCount)
    .refine(values => new Set(values.map(value => value.id)).size === values.length),
}).strict();

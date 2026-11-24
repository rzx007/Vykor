/** Node-only local daemon management. Import from @rzx/client/service. */
import { clientOptions, discover, ensure, stop } from "./service.js";

export const Service = { discover, ensure, stop, clientOptions };
export { discover, ensure, stop, clientOptions };
export type { DiscoverServiceOptions, EnsureServiceOptions, ServiceStartupChannel } from "./service.js";
export type { ServiceEndpoint } from "./registry.js";

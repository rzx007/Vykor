import { VykorClient } from "@vykor/client";

// A real browser consumer keeps the complete resource reachable without issuing requests.
Object.assign(window, { vykorClient: new VykorClient({ baseUrl: "http://127.0.0.1:8787" }) });

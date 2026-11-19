import { Hono } from "hono";

import { jsonResponse } from "../support.js";

/** Existing Desktop clients get a clear upgrade message for retired routes. */
export function createRetiredNotesRoutes(): Hono {
  const moved = () => jsonResponse({
    code: "notes_moved",
    error: "便签已迁移到桌面端。请更新桌面应用后重新打开便签。",
  }, 410);
  return new Hono().all("/", moved).all("/*", moved);
}

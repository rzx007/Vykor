import {
  createHashHistory,
  createMemoryHistory,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router"

import { routeTree } from "@renderer/routeTree.gen"
import { DesktopRoutePending } from "@renderer/routes/__root"

const history: RouterHistory =
  typeof window === "undefined"
    ? createMemoryHistory({ initialEntries: ["/"] })
    : createHashHistory()

export const router = createRouter({
  routeTree,
  history,
  defaultPendingComponent: DesktopRoutePending,
  defaultPendingMs: 0,
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

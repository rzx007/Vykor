import {
  createHashHistory,
  createMemoryHistory,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router"

import { routeTree } from "@renderer/routeTree.gen"

const history: RouterHistory =
  typeof window === "undefined"
    ? createMemoryHistory({ initialEntries: ["/"] })
    : createHashHistory()

export const router = createRouter({ routeTree, history })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

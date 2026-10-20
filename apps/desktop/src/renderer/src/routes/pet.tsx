import { createFileRoute } from "@tanstack/react-router"

import { PetWindow } from "@renderer/components/desktop/pet-page/pet-page"
import { dismissStartupLoading } from "@renderer/dismiss-startup-loading"

export const Route = createFileRoute("/pet")({
  beforeLoad: () => {
    dismissStartupLoading()
  },
  component: PetWindow,
})

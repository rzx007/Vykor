import { createFileRoute } from "@tanstack/react-router"

import { NotesPage } from "@renderer/components/desktop/notes-page"

export const Route = createFileRoute("/_main/notes")({
  component: NotesPage,
})

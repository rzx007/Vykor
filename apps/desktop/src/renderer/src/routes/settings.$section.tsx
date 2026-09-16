import { createFileRoute, redirect } from "@tanstack/react-router"

import { SettingsContent } from "@renderer/components/desktop/settings-page"
import {
  isSettingsSection,
  settingsSectionLabel,
} from "@renderer/components/desktop/settings-page/settings-navigation"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"

export const Route = createFileRoute("/settings/$section")({
  beforeLoad: async ({ params }) => {
    await useDesktopSessionStore.getState().initialize()
    if (isSettingsSection(params.section)) return
    throw redirect({
      to: "/settings/$section",
      params: { section: "general" },
      replace: true,
    })
  },
  component: SettingsRoute,
})

function SettingsRoute(): React.JSX.Element {
  const { section } = Route.useParams()
  return <SettingsContent selectedSection={settingsSectionLabel(section)} />
}

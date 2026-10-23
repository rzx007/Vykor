import type { VykorClient } from "@rzx/client"
/** Match the real session model against current provider models; a configured label alone is insufficient. */
export async function pluginAppMessageReady(client: VykorClient, sessionId: string): Promise<boolean> {
  const [session, settings, providers] = await Promise.all([
    client.sessions.get(sessionId), client.system.getSettings(), client.providers.listModels(),
  ])
  if (settings.modelDisabled === true || session.status === "archived" || session.status === "closing" || !session.model) return false
  const runtime = session.metadata.runtime as { provider?: string } | undefined
  return providers.some(provider => provider.models.some(model => model.id === session.model
    && (!runtime?.provider || model.providerName === runtime.provider)))
}

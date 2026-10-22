import type { HostedAgent } from "@vykor/agent-runtime";

/** Explicit host wiring for small test doubles and real Node agents. */
export function hostedAgentFixture(agent: any): HostedAgent {
  if (agent?.agent) return agent;
  return {
    agent,
    host: agent.host ?? {
      plugins: {
        pluginApps: agent.pluginApps,
        createRunCapabilityView:
          agent.createRunCapabilityView ?? (() => undefined),
        getPluginCandidates: agent.getPluginCandidates,
        validatePluginScope: agent.validatePluginScope,
        runPluginAppTool: agent.runPluginAppTool,
        listModelVisibleTools: agent.listModelVisibleTools ?? (() => []),
        prepareRun: (view: any) => ({
          fixtureView: view,
          prepare: async () => ({ run: { tools: view.tools }, release() {} }),
        }),
      },
      configuration: {
        getSnapshot: agent.getConfiguration,
        updateConfiguration: agent.updateConfiguration,
        setModel: agent.setModel,
      },
      memory: { remember: agent.remember },
      inspect: agent.inspect,
      workflows: agent.workflows,
    },
  };
}
export function hostedAgentFactory(factory?: (...args: any[]) => any): any {
  if (!factory) return undefined;
  return async (...args: any[]) => hostedAgentFixture(await factory(...args));
}

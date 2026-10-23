import type { ReactNode } from "react"
import type { MarketplaceEntry } from "@rzx/client"
import { PluginDetailContent } from "./plugin-detail"

const capabilityLabels: Record<string, string> = {
  tool: "工具",
  tools: "工具",
  mcp: "工具服务",
  app: "常驻应用",
  apps: "常驻应用",
  skill: "技能",
  skills: "技能",
  agent: "智能体",
  agents: "智能体",
  hook: "运行钩子",
  hooks: "运行钩子",
  command: "快捷命令",
  commands: "快捷命令",
  workflows: "工作流",
}
const categoryLabels: Record<string, string> = {
  productivity: "效率工具",
  development: "开发工具",
  research: "研究与资料",
  design: "设计",
  creativity: "创作",
  automation: "自动化",
  data: "数据",
  utilities: "实用工具",
}

export function MarketplaceDetail({
  entry,
  sourceName,
  installedSourceName,
  action,
  receipt,
  onBack,
  starting,
  onPrompt,
}: {
  entry: MarketplaceEntry
  sourceName: string
  installedSourceName?: string
  action: ReactNode
  receipt?: ReactNode
  onBack: () => void
  starting?: boolean
  onPrompt?: (prompt: string) => void
}): React.JSX.Element {
  const plugin = entry.plugin
  return (
    <PluginDetailContent
      name={plugin.displayName ?? plugin.name}
      version={plugin.version}
      presentation={{
        icon: plugin.icon,
        description: plugin.description,
        introduction: plugin.introduction,
        prompts: plugin.prompts,
        author: plugin.author,
        license: plugin.license,
        keywords: plugin.keywords,
        homepage: plugin.homepage,
        repository: plugin.source.repository,
      }}
      backLabel="返回插件市场"
      onBack={onBack}
      actions={action}
      starting={starting}
      onPrompt={onPrompt}
      status={
        !entry.compatible ? (
          <p className="text-xs text-destructive">{entry.incompatibility ?? "与当前版本不兼容"}</p>
        ) : undefined
      }
      information={
        <>
          {entry.installedVersion ? (
            <>
              <dt className="text-muted-foreground">已安装版本</dt>
              <dd>{entry.installedVersion}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">插件源</dt>
          <dd>{sourceName}</dd>
          {entry.installedVersion ? (
            <>
              <dt className="text-muted-foreground">安装来源</dt>
              <dd>{installedSourceName ?? "未关联插件源"}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">分类</dt>
          <dd>{categoryLabels[plugin.category] ?? plugin.category}</dd>
          {plugin.componentTypes.length ? (
            <>
              <dt className="text-muted-foreground">能力</dt>
              <dd>
                {[
                  ...new Set(plugin.componentTypes.map((type) => capabilityLabels[type] ?? type)),
                ].join("、")}
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Vykor 版本</dt>
          <dd>{plugin.requires.host}</dd>
          {plugin.requires.node ? (
            <>
              <dt className="text-muted-foreground">Node.js</dt>
              <dd>{plugin.requires.node}</dd>
            </>
          ) : null}
          {plugin.requires.platforms?.length ? (
            <>
              <dt className="text-muted-foreground">支持平台</dt>
              <dd>{plugin.requires.platforms.join("、")}</dd>
            </>
          ) : null}
        </>
      }
    >
      {receipt}
    </PluginDetailContent>
  )
}

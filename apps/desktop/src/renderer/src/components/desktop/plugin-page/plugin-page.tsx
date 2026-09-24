import { ChevronDown, CircleCheck, RefreshCw, Search, Settings2, X } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@renderer/components/ui/input-group"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { Switch } from "@renderer/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@renderer/components/ui/tabs"
import { useDesktopSessionStore } from "@renderer/stores/desktop-session"
import { PluginManager } from "./plugin-manager"
import { SkillManager } from "./skill-manager"
import { McpManager } from "./mcp-manager"

type ExtensionTab = "plugins" | "skills" | "mcp"
const sections = {
  plugins: { title: "插件", description: "将你常用的工具，带入 Vykor" },
  skills: { title: "技能", description: "用任务专用技能扩展 Vykor" },
  mcp: { title: "MCP", description: "连接工具与数据，扩展 Vykor" },
} as const
const initialCounts = { plugins: 0, skills: 0, mcp: 0 }

export function PluginPage(): React.JSX.Element {
  const project = useDesktopSessionStore((state) => state.selectedProject)
  const sessionCwd = useDesktopSessionStore((state) => state.sessionView?.session.cwd)
  const projectPath = project?.path ?? sessionCwd ?? "."
  return <ExtensionManagement key={projectPath} projectPath={projectPath} />
}

function ExtensionManagement({ projectPath }: { projectPath: string }): React.JSX.Element {
  const [tab, setTab] = useState<ExtensionTab>("plugins")
  const [queries, setQueries] = useState({ plugins: "", skills: "", mcp: "" })
  const [addRequests, setAddRequests] = useState(initialCounts)
  const [gitAddRequest, setGitAddRequest] = useState(0)
  const [refreshRequests, setRefreshRequests] = useState(initialCounts)
  const [message, setMessage] = useState("")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [compact, setCompact] = useState(false)

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(""), 5000)
    return () => window.clearTimeout(timer)
  }, [message])

  function add(target: "plugins" | "mcp"): void {
    setTab(target)
    setAddRequests((previous) => ({ ...previous, [target]: previous[target] + 1 }))
  }
  function addPluginFromGit(): void {
    setTab("plugins")
    setGitAddRequest((previous) => previous + 1)
  }

  return (
    <section
      className="extension-management flex h-full min-h-0 w-full flex-col bg-background"
      data-compact={compact}
    >
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as ExtensionTab)}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="flex min-h-14 shrink-0 items-center justify-between gap-3 px-4 py-2 sm:px-6">
          <TabsList className="extension-tabs bg-transparent" aria-label="扩展管理">
            <TabsTrigger value="plugins">插件</TabsTrigger>
            <TabsTrigger value="skills">技能</TabsTrigger>
            <TabsTrigger value="mcp">MCP</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              aria-label={`刷新${sections[tab].title}`}
              title="刷新列表"
              onClick={() =>
                setRefreshRequests((previous) => ({ ...previous, [tab]: previous[tab] + 1 }))
              }
            >
              <RefreshCw />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="显示设置"
              title="显示设置"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings2 />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button />} aria-label="添加扩展">
                添加
                <ChevronDown data-icon="inline-end" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => add("plugins")}>导入插件包</DropdownMenuItem>
                  <DropdownMenuItem onClick={addPluginFromGit}>从 Git 安装</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => add("mcp")}>添加 MCP 服务器</DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <ScrollArea horizontal={false} className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-8 px-6 pt-7 pb-16 sm:px-10 sm:pt-9 lg:px-12">
            <header className="flex flex-col gap-2">
              <h1 className="text-[28px] leading-tight font-medium tracking-tight">
                {sections[tab].title}
              </h1>
              <p className="text-sm leading-6 text-muted-foreground">{sections[tab].description}</p>
            </header>
            <InputGroup className="h-8 rounded-full shadow-none">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                aria-label={`搜索${sections[tab].title}`}
                placeholder={`搜索${sections[tab].title}`}
                value={queries[tab]}
                onChange={(event) =>
                  setQueries((previous) => ({ ...previous, [tab]: event.target.value }))
                }
              />
              {queries[tab] ? (
                <InputGroupAddon align="inline-end">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="清除搜索"
                    onClick={() => setQueries((previous) => ({ ...previous, [tab]: "" }))}
                  >
                    <X />
                  </Button>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
            <TabsContent value="plugins" keepMounted>
              <PluginManager
                key={projectPath}
                projectPath={projectPath}
                query={queries.plugins}
                addRequest={addRequests.plugins}
                gitAddRequest={gitAddRequest}
                refreshRequest={refreshRequests.plugins}
                notify={setMessage}
              />
            </TabsContent>
            <TabsContent value="skills" keepMounted>
              <SkillManager
                key={projectPath}
                projectPath={projectPath}
                query={queries.skills}
                refreshRequest={refreshRequests.skills}
                notify={setMessage}
              />
            </TabsContent>
            <TabsContent value="mcp" keepMounted>
              <McpManager
                query={queries.mcp}
                addRequest={addRequests.mcp}
                refreshRequest={refreshRequests.mcp}
                notify={setMessage}
              />
            </TabsContent>
          </div>
        </ScrollArea>
      </Tabs>
      {message ? (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-t border-border/60 bg-background px-6 py-2 text-xs text-muted-foreground"
        >
          <CircleCheck className="size-3.5 shrink-0" />
          <span className="flex-1">{message}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="关闭提示"
            onClick={() => setMessage("")}
          >
            <X />
          </Button>
        </div>
      ) : null}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="p-6 sm:max-w-md">
          <DialogHeader>
            <DialogTitle>显示设置</DialogTitle>
            <DialogDescription>调整扩展管理页面的阅读密度。</DialogDescription>
          </DialogHeader>
          <label className="flex items-center justify-between gap-4 py-4">
            <span>紧凑列表</span>
            <Switch checked={compact} onCheckedChange={setCompact} />
          </label>
          <p className="text-xs leading-5 text-muted-foreground">
            列表会按当前项目刷新；本机配置仍保存在当前设备。
          </p>
        </DialogContent>
      </Dialog>
    </section>
  )
}

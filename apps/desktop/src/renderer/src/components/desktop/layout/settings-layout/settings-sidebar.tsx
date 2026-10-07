import { ArrowLeft, Search } from "lucide-react"
import { useState } from "react"
import { searchSettings } from "@renderer/components/desktop/settings-page/settings-search"

import {
  codingSettingsNavigation,
  integrationSettingsNavigation,
  personalSettingsNavigation,
  agentSettingsNavigation,
  maintenanceSettingsNavigation,
  type SettingsNavigationItem,
} from "@renderer/components/desktop/settings-page/settings-navigation"
import { SharedLayoutBg } from "@renderer/components/motion/shared-layout-bg"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { cn } from "@renderer/lib/utils"

type SettingsSidebarProps = {
  onClose: () => void
  selectedSection: string
  onSelectSection: (section: string, target?: string) => void
}

export function SettingsSidebar({
  onClose,
  selectedSection,
  onSelectSection,
}: SettingsSidebarProps): React.JSX.Element {
  const [query, setQuery] = useState("")
  const [activeResult, setActiveResult] = useState(0)
  const results = searchSettings(query)
  const openResult = (index: number) => { const result = results[index]; if (result) { onSelectSection(result.label, result.target); setQuery(""); setActiveResult(0) } }
  return (
    <aside
      data-settings-sidebar
      className="flex h-full min-h-0 w-full flex-col bg-transparent py-3 text-sidebar-foreground"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onClose}
        className="mb-4 w-fit text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground"
      >
        <ArrowLeft data-icon="inline-start" />
        返回应用
      </Button>

      <div className="relative mx-2 mb-5">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="搜索设置"
          placeholder="搜索设置..."
          value={query}
          role="combobox"
          aria-expanded={Boolean(query.trim())}
          aria-controls="settings-search-results"
          aria-activedescendant={results[activeResult] ? `settings-result-${activeResult}` : undefined}
          onChange={event => { setQuery(event.target.value); setActiveResult(0) }}
          onKeyDown={event => {
            if (event.key === "Escape") { setQuery(""); setActiveResult(0); return }
            if (!query.trim()) return
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActiveResult(current => Math.max(0, Math.min(results.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))) }
            if (event.key === "Enter") { event.preventDefault(); openResult(activeResult) }
          }}
          className="h-9 rounded-full bg-background pl-9 shadow-none"
        />
      </div>

      <ScrollArea horizontal={false} className="min-h-0 flex-1 px-2">
        {query.trim() ? <div>
          {results.length ? <div id="settings-search-results" role="listbox" aria-label="设置搜索结果" className="flex flex-col gap-1">{results.map((result, index) => <button key={`${result.section}:${result.title}`} id={`settings-result-${index}`} role="option" aria-selected={activeResult === index} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActiveResult(index)} onClick={() => openResult(index)} className={cn("flex flex-col gap-1 rounded-md px-3 py-2 text-left text-sm hover:bg-sidebar-accent", activeResult === index && "bg-sidebar-selected")}><span>{result.title}</span><span className="text-xs text-sidebar-muted">{result.label}</span></button>)}</div> : <p role="status" className="px-3 py-2 text-sm text-sidebar-muted">没有找到设置，请换一个关键词。</p>}
        </div> : <>
        <SettingsNavigationGroup
          label="应用"
          items={personalSettingsNavigation}
          selectedSection={selectedSection}
          onSelect={onSelectSection}
        />
        <SettingsNavigationGroup label="智能体" items={agentSettingsNavigation} selectedSection={selectedSection} onSelect={onSelectSection} />
        <SettingsNavigationGroup
          label="集成"
          items={integrationSettingsNavigation}
          selectedSection={selectedSection}
          onSelect={onSelectSection}
        />
        <SettingsNavigationGroup
          label="编码"
          items={codingSettingsNavigation}
          selectedSection={selectedSection}
          onSelect={onSelectSection}
        />
        <SettingsNavigationGroup label="维护" items={maintenanceSettingsNavigation} selectedSection={selectedSection} onSelect={onSelectSection} />
        </>}
      </ScrollArea>

      <div className="flex items-center gap-2 border-t border-sidebar-border px-2 pt-3">
        <span className="text-ui-caption grid size-7 place-items-center rounded-full bg-amber-400 font-semibold text-amber-950">
          OH
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">Vykor</p>
          <p className="text-ui-caption truncate text-sidebar-muted">本地工作区</p>
        </div>
      </div>
    </aside>
  )
}

function SettingsNavigationGroup({
  label,
  items,
  selectedSection,
  onSelect,
}: {
  label: string
  items: SettingsNavigationItem[]
  selectedSection: string
  onSelect: (label: string) => void
}): React.JSX.Element {
  return (
    <nav className="mb-5" aria-label={`${label}设置`}>
      <p className="px-2 pb-1.5 text-xs text-sidebar-muted/70">{label}</p>
      <SharedLayoutBg className="gap-0.5" inset={0} pillClassName="rounded-md bg-sidebar-accent">
        {items.map(({ label: itemLabel, icon: Icon }) => (
          <div key={itemLabel}>
            <button
              type="button"
              aria-current={selectedSection === itemLabel ? "page" : undefined}
              onClick={() => onSelect(itemLabel)}
              className={cn(
                "text-ui-small flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                selectedSection === itemLabel
                  ? "bg-sidebar-selected font-medium text-sidebar-foreground"
                  : "text-sidebar-foreground/82"
              )}
            >
              <Icon className="size-4 text-sidebar-muted" strokeWidth={1.8} />
              {itemLabel}
            </button>
          </div>
        ))}
      </SharedLayoutBg>
    </nav>
  )
}

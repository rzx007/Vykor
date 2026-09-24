import { ArrowLeft, Search } from "lucide-react"

import {
  codingSettingsNavigation,
  integrationSettingsNavigation,
  personalSettingsNavigation,
  type SettingsNavigationItem,
} from "@renderer/components/desktop/settings-page/settings-navigation"
import { Button } from "@renderer/components/ui/button"
import { Input } from "@renderer/components/ui/input"
import { ScrollArea } from "@renderer/components/ui/scroll-area"
import { cn } from "@renderer/lib/utils"

type SettingsSidebarProps = {
  onClose: () => void
  selectedSection: string
  onSelectSection: (section: string) => void
}

export function SettingsSidebar({
  onClose,
  selectedSection,
  onSelectSection,
}: SettingsSidebarProps): React.JSX.Element {
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
          className="h-9 rounded-full bg-background pl-9 shadow-none"
        />
      </div>

      <ScrollArea horizontal={false} className="min-h-0 flex-1 px-2">
        <SettingsNavigationGroup
          label="个人"
          items={personalSettingsNavigation}
          selectedSection={selectedSection}
          onSelect={onSelectSection}
        />
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
      <div className="flex flex-col gap-0.5">
        {items.map(({ label: itemLabel, icon: Icon }) => (
          <button
            key={itemLabel}
            type="button"
            aria-current={selectedSection === itemLabel ? "page" : undefined}
            onClick={() => onSelect(itemLabel)}
            className={cn(
              "text-ui-small flex h-8 items-center gap-2.5 rounded-md px-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              selectedSection === itemLabel
                ? "bg-sidebar-selected font-medium text-sidebar-foreground"
                : "text-sidebar-foreground/82 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            )}
          >
            <Icon className="size-4 text-sidebar-muted" strokeWidth={1.8} />
            {itemLabel}
          </button>
        ))}
      </div>
    </nav>
  )
}

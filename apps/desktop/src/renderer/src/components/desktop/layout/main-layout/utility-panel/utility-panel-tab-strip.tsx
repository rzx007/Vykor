import { CirclePlus, Minimize2, PanelRightClose, X } from "lucide-react"
import { useState } from "react"
import { createPortal } from "react-dom"

import type { BrowserToolTab } from "@renderer/components/desktop/tools/browser-tool"
import { Button } from "@renderer/components/ui/button"
import { ButtonGroup } from "@renderer/components/ui/button-group"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@renderer/components/ui/item"
import { Kbd } from "@renderer/components/ui/kbd"
import { cn } from "@renderer/lib/utils"
import { utilityToolMeta, type UtilityTab, type UtilityTool } from "./utility-panel-tabs"

type UtilityPanelTabStripProps = {
  tabs: UtilityTab[]
  browserTabs: BrowserToolTab[]
  activeTab?: UtilityTab
  availableTools: UtilityTool[]
  maximized: boolean
  onAdd: (tool: UtilityTool) => void
  onSelect: (tab: UtilityTab) => void
  onCloseTab: (tabId: string) => void
  onCloseOtherTabs: (tab: UtilityTab) => void
  onCloseTabsToRight: (tab: UtilityTab) => void
  onToggleMaximized: () => void
  onClosePanel: () => void
}

export function UtilityPanelTabStrip({
  tabs,
  browserTabs,
  activeTab,
  availableTools,
  maximized,
  onAdd,
  onSelect,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onToggleMaximized,
  onClosePanel,
}: UtilityPanelTabStripProps): React.JSX.Element {
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null)

  const toggleAddMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (menuPosition) {
      setMenuPosition(null)
      return
    }

    const rect = event.currentTarget.getBoundingClientRect()
    const menuWidth = 320
    setMenuPosition({
      left: Math.max(12, Math.min(rect.left, window.innerWidth - menuWidth - 12)),
      top: rect.bottom + 4,
    })
  }

  const addTool = (tool: UtilityTool): void => {
    setMenuPosition(null)
    onAdd(tool)
  }

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 bg-conversation px-3">
        <div className="utility-tab-strip flex min-w-0 flex-1 items-center overflow-x-auto">
          {tabs.map((tab, index) => (
            <UtilityTabButton
              key={tab.id}
              tab={tab}
              active={tab.id === activeTab?.id}
              loading={browserTabs.find((item) => item.id === tab.id)?.loading}
              showSeparator={index < tabs.length - 1}
              tabCount={tabs.length}
              rightCount={tabs.length - index - 1}
              onSelect={() => onSelect(tab)}
              onClose={() => onCloseTab(tab.id)}
              onCloseOthers={() => onCloseOtherTabs(tab)}
              onCloseRight={() => onCloseTabsToRight(tab)}
            />
          ))}
          {tabs.length > 0 && (
            <div className="relative ml-1 shrink-0">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                shape="circle"
                title="新建工具标签"
                aria-label="新建工具标签"
                onClick={toggleAddMenu}
                className="text-muted-foreground"
              >
                <CirclePlus />
              </Button>
            </div>
          )}
        </div>

        <ButtonGroup variant="toolbar" aria-label="工具面板操作">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            shape="circle"
            title={maximized ? "恢复面板" : "最大化面板"}
            aria-label={maximized ? "恢复面板" : "最大化面板"}
            aria-pressed={maximized}
            onClick={onToggleMaximized}
            className="text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
          >
            <Minimize2 className={cn(!maximized && "rotate-180", "size-3.5")} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            shape="circle"
            title="关闭面板"
            aria-label="关闭面板"
            onClick={onClosePanel}
          >
            <PanelRightClose className="size-3.5" />
          </Button>
        </ButtonGroup>
      </header>

      {menuPosition &&
        createPortal(
          <AddTabMenu
            activeTab={activeTab}
            availableTools={availableTools}
            position={menuPosition}
            onAdd={addTool}
          />,
          document.body
        )}
    </>
  )
}

export function EmptyUtilityPanelState({
  availableTools,
  onAdd,
}: {
  availableTools: UtilityTool[]
  onAdd: (tool: UtilityTool) => void
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 items-center justify-center px-8">
      <ItemGroup className="w-full max-w-130 gap-0!">
        {availableTools.map((tool) => {
          const Icon = utilityToolMeta[tool].icon
          return (
            <Item
              key={tool}
              size="sm"
              render={<button type="button" onClick={() => onAdd(tool)} />}
              className="h-10 cursor-pointer flex-nowrap bg-transparent text-left text-sidebar-foreground hover:bg-muted"
            >
              <ItemMedia variant="icon" className="size-4">
                <Icon strokeWidth={1.8} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="text-ui-small font-normal">
                  {utilityToolMeta[tool].label}
                </ItemTitle>
              </ItemContent>
              <ItemActions className="min-w-28 justify-end">
                {utilityToolMeta[tool].shortcut ? (
                  <Kbd className="text-ui-caption bg-code text-muted-foreground">
                    {utilityToolMeta[tool].shortcut}
                  </Kbd>
                ) : null}
              </ItemActions>
            </Item>
          )
        })}
      </ItemGroup>
    </div>
  )
}

function UtilityTabButton({
  tab,
  active,
  loading,
  showSeparator,
  tabCount,
  rightCount,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseRight,
}: {
  tab: UtilityTab
  active: boolean
  loading?: boolean
  showSeparator: boolean
  tabCount: number
  rightCount: number
  onSelect: () => void
  onClose: () => void
  onCloseOthers: () => void
  onCloseRight: () => void
}): React.JSX.Element {
  const Icon = utilityToolMeta[tab.tool].icon
  const TabIcon = tab.fileIcon ?? Icon

  return (
    <ContextMenu>
      <ContextMenuTrigger
        className={cn(
          "text-ui-small group relative flex h-8 max-w-42 min-w-28 flex-[1_1_10.5rem] items-center rounded-xl transition-colors",
          active
            ? "bg-muted text-ui-foreground"
            : "text-ui-muted hover:bg-muted/35 hover:text-ui-foreground",
          showSeparator &&
            "after:absolute after:top-2 after:-right-0.5 after:h-4 after:w-px after:bg-border/55"
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          className="flex h-full min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-xl px-2.5 pr-1 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          title={tab.title}
        >
          <TabIcon
            className={cn("size-3.5 shrink-0", loading && "animate-pulse")}
            strokeWidth={1.75}
          />
          <span className="utility-tab-title relative min-w-0 flex-1 overflow-hidden text-xs whitespace-nowrap">
            {tab.title}
          </span>
        </button>
        <button
          type="button"
          aria-label="关闭标签"
          title="关闭标签"
          onClick={onClose}
          className={cn(
            "mr-1 grid size-6 shrink-0 place-items-center rounded-full text-ui-muted transition-opacity group-hover:opacity-100 hover:bg-background hover:text-ui-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            active ? "opacity-75" : "opacity-0"
          )}
        >
          <X className="size-3.5" />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onClick={onClose}>关闭</ContextMenuItem>
        <ContextMenuItem disabled={tabCount <= 1} onClick={onCloseOthers}>
          关闭其他标签
        </ContextMenuItem>
        <ContextMenuItem disabled={rightCount === 0} onClick={onCloseRight}>
          关闭右侧标签
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function AddTabMenu({
  activeTab,
  availableTools,
  position,
  onAdd,
}: {
  activeTab?: UtilityTab
  availableTools: UtilityTool[]
  position: { left: number; top: number }
  onAdd: (tool: UtilityTool) => void
}): React.JSX.Element {
  return (
    <div
      className="fixed z-80 w-80 rounded-xl border bg-popover p-2 text-popover-foreground shadow-lg"
      style={{ left: position.left, top: position.top }}
    >
      {availableTools.map((tool) => {
        const Icon = utilityToolMeta[tool].icon
        const disabled = tool !== "browser" && tool !== "terminal" && activeTab?.tool === tool
        return (
          <Button
            key={tool}
            type="button"
            variant="ghost"
            disabled={disabled}
            onClick={() => onAdd(tool)}
            className="h-10 w-full justify-start gap-2 px-2.5 text-sm font-normal"
          >
            <Icon className="text-muted-foreground" strokeWidth={1.8} />
            <span>{utilityToolMeta[tool].label}</span>
            {utilityToolMeta[tool].shortcut && (
              <Kbd className="text-ui-caption ml-auto bg-code text-muted-foreground">
                {utilityToolMeta[tool].shortcut}
              </Kbd>
            )}
          </Button>
        )
      })}
    </div>
  )
}

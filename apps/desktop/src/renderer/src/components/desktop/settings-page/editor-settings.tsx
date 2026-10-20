import { useEditorPreferences } from "@renderer/stores/editor-preferences"
import { Switch } from "@renderer/components/ui/switch"
import { SettingsGroup, SettingsRow, SettingsSelect } from "./settings-group"

export function EditorSettings() {
  const { readOnly, wordWrap, tabSize, update } = useEditorPreferences()
  return (
    <SettingsGroup title="编辑器">
      <SettingsRow
        title="只读模式"
        control={
          <Switch
            aria-label="只读模式"
            checked={readOnly}
            onCheckedChange={(readOnly) => update({ readOnly })}
          />
        }
      />
      <SettingsRow
        title="自动换行"
        control={
          <Switch
            aria-label="自动换行"
            checked={wordWrap}
            onCheckedChange={(wordWrap) => update({ wordWrap })}
          />
        }
      />
      <SettingsRow
        title="Tab 宽度"
        control={
          <SettingsSelect
            label="Tab 宽度"
            value={String(tabSize)}
            options={[
              { value: "2", label: "2 个空格" },
              { value: "4", label: "4 个空格" },
            ]}
            onChange={(value) => update({ tabSize: value === "4" ? 4 : 2 })}
          />
        }
      />
    </SettingsGroup>
  )
}

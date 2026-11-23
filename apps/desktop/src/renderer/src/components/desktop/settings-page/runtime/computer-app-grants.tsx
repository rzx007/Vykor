import { useEffect, useState } from "react"
import { Button } from "@renderer/components/ui/button"
import type { DesktopComputerAppGrant } from "@shared/computer-types"
import { errorMessage } from "../shared/settings-error-message"
import { SettingsGroup, SettingsRow } from "../shared/settings-group"

export function ComputerAppGrants(): React.JSX.Element | null {
  const computer = window.desktop?.computer
  const [grants, setGrants] = useState<DesktopComputerAppGrant[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState(false)
  useEffect(() => {
    if (!computer?.supported) return
    let active = true
    void computer.listAppGrants().then(
      (result) => { if (active) setGrants(result) },
      (failure) => { if (active) setError(errorMessage(failure)) },
    )
    return () => { active = false }
  }, [computer])

  if (!computer?.supported) return null
  async function revoke(id: string) {
    setRevoking(true)
    setError(null)
    try {
      setGrants(await window.desktop.computer.revokeAppGrant(id))
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setRevoking(false)
    }
  }
  return (
    <SettingsGroup title="电脑操作 · 始终允许的应用">
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {grants?.length === 0 ? <p className="text-sm text-muted-foreground">没有已授权的应用。</p> : null}
      {grants?.map((grant) => (
        <SettingsRow key={grant.id} title={grant.name} control={
          <Button variant="outline" size="sm" disabled={revoking} aria-label={`撤销 ${grant.name} 的访问许可`}
            onClick={() => void revoke(grant.id)}>撤销</Button>
        } />
      ))}
    </SettingsGroup>
  )
}

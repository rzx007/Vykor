# OpenHarness 开发数据重置手册

> 状态：权威重置手册。本文只定义人工预检和授权流程，不执行删除。

代码验收与真实数据重置是两个独立状态；合并代码不表示本机数据已经重置。

## 1. 先确定精确叶子

不要把 `OPENHARNESS_CONFIG_DIR` 指向的整个目录直接列为删除目标。把实际使用的路径填进清单，并且每行只写一个 OpenHarness 独占叶子：

| 类别 | 精确叶子（按实际路径填写） | 建议允许根 | 可恢复性 |
|---|---|---|---|
| override config | `<OPENHARNESS_CONFIG_DIR>\settings.json` | `OPENHARNESS_CONFIG_DIR` | 删除后不可恢复；配置会回到默认值 |
| override credentials | `<OPENHARNESS_CONFIG_DIR>\credentials.json` | `OPENHARNESS_CONFIG_DIR` | 删除后不可恢复；需要重新登录 |
| channel config & secret | `<OPENHARNESS_CONFIG_DIR>\channel-credentials.json` | `OPENHARNESS_CONFIG_DIR` | 含渠道配置与密钥；删除后不可恢复，需要重新 `ohs channels add feishu` |
| override profile | `<OPENHARNESS_CONFIG_DIR>\USER.md` | `OPENHARNESS_CONFIG_DIR` | 删除后不可恢复 |
| override runtime data | `<OPENHARNESS_CONFIG_DIR>\data` | `OPENHARNESS_CONFIG_DIR` | Session、Run、日志和任务不可恢复 |
| override plugins | `<OPENHARNESS_CONFIG_DIR>\plugins` | `OPENHARNESS_CONFIG_DIR` | 安装状态与 cache 不可恢复 |
| override skills | `<OPENHARNESS_CONFIG_DIR>\skills` | `OPENHARNESS_CONFIG_DIR` | 用户 Skill 不可恢复 |
| override model cache | `<OPENHARNESS_CONFIG_DIR>\cache\models-dev.json` | `OPENHARNESS_CONFIG_DIR` | 可重新生成 |
| default config | `<HOME>\.openharness-ts` 下与上面相同的精确叶子 | `<HOME>\.openharness-ts` | 同上；不要把 HOME 列为目标 |
| project | `<PROJECT>\.openharness-ts` | 已确认的 `<PROJECT>` | 项目设置、memory 和局部数据不可恢复 |
| Desktop preferences | `<Desktop userData>\desktop-preferences.json` | 精确的 Desktop userData | 删除后回到默认值 |
| Desktop pet | `<Desktop userData>\desktop-pet.json` | 精确的 Desktop userData | 删除后回到默认值 |
| Desktop local storage | `<Desktop userData>\Local Storage\leveldb` | 精确的 Desktop userData | Desktop 局部状态不可恢复 |
| Desktop cache | `<Electron app cache>\<OpenHarness leaf>` | 精确的 Electron app cache | 可重新生成 |

如果 override 目录与默认目录相同，只保留一组。Desktop `userData` 和 cache 必须从当前 Electron 应用实际输出取得，不得猜产品目录名。任何希望保留的文件都要在授权前另行复制；本流程不自动备份或迁移。

## 2. 第一次预检

在普通 PowerShell 中建立清单。下面只读取路径，不删除文件：

```powershell
$WorkspaceRoot = 'D:\code\personal-project\OpenHarness-ts'
$ConfigRoot = if ($env:OPENHARNESS_CONFIG_DIR) { $env:OPENHARNESS_CONFIG_DIR } else { Join-Path $HOME '.openharness-ts' }
$ProjectRoot = '<填写项目根的精确绝对路径>'
$DesktopUserDataRoot = '<填写 Electron 实际 userData 绝对路径>'
$DesktopCacheRoot = '<填写 Electron 实际 cache 绝对路径>'

$AllowedRoots = @(
  $ConfigRoot,
  $ProjectRoot,
  $DesktopUserDataRoot,
  $DesktopCacheRoot
) | ForEach-Object { [IO.Path]::GetFullPath($_) }

$Candidates = @(
  @{ Name = 'settings'; InputPath = (Join-Path $ConfigRoot 'settings.json'); AllowedRoot = $ConfigRoot; Recoverable = $false },
  @{ Name = 'credentials'; InputPath = (Join-Path $ConfigRoot 'credentials.json'); AllowedRoot = $ConfigRoot; Recoverable = $false },
  @{ Name = 'channel-credentials'; InputPath = (Join-Path $ConfigRoot 'channel-credentials.json'); AllowedRoot = $ConfigRoot; Recoverable = $false },
  @{ Name = 'profile'; InputPath = (Join-Path $ConfigRoot 'USER.md'); AllowedRoot = $ConfigRoot; Recoverable = $false },
  @{ Name = 'runtime-data'; InputPath = (Join-Path $ConfigRoot 'data'); AllowedRoot = $ConfigRoot; Recoverable = $false },
  @{ Name = 'plugins'; InputPath = (Join-Path $ConfigRoot 'plugins'); AllowedRoot = $ConfigRoot; Recoverable = $false },
  @{ Name = 'skills'; InputPath = (Join-Path $ConfigRoot 'skills'); AllowedRoot = $ConfigRoot; Recoverable = $false },
  @{ Name = 'model-cache'; InputPath = (Join-Path $ConfigRoot 'cache\models-dev.json'); AllowedRoot = $ConfigRoot; Recoverable = $true },
  @{ Name = 'project-state'; InputPath = (Join-Path $ProjectRoot '.openharness-ts'); AllowedRoot = $ProjectRoot; Recoverable = $false },
  @{ Name = 'desktop-preferences'; InputPath = (Join-Path $DesktopUserDataRoot 'desktop-preferences.json'); AllowedRoot = $DesktopUserDataRoot; Recoverable = $false },
  @{ Name = 'desktop-pet'; InputPath = (Join-Path $DesktopUserDataRoot 'desktop-pet.json'); AllowedRoot = $DesktopUserDataRoot; Recoverable = $false },
  @{ Name = 'desktop-local-storage'; InputPath = (Join-Path $DesktopUserDataRoot 'Local Storage\leveldb'); AllowedRoot = $DesktopUserDataRoot; Recoverable = $false },
  @{ Name = 'desktop-cache'; InputPath = '<填写 cache 内 OpenHarness 独占叶子的精确路径>'; AllowedRoot = $DesktopCacheRoot; Recoverable = $true }
)

function Get-CanonicalPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  if (Test-Path -LiteralPath $full) {
    return (Resolve-Path -LiteralPath $full).ProviderPath
  }
  return $full
}

function Get-FinalPath([string]$Path) {
  $canonical = Get-CanonicalPath $Path
  if (-not (Test-Path -LiteralPath $canonical)) { return $canonical }
  $item = Get-Item -LiteralPath $canonical -Force
  if ($item.LinkType) {
    $target = $item.ResolveLinkTarget($true)
    if (-not $target) { throw "无法解析链接最终目标: $canonical" }
    return [IO.Path]::GetFullPath($target.FullName)
  }
  return [IO.Path]::GetFullPath($item.FullName)
}

function Test-IsInside([string]$Child, [string]$Root) {
  $relative = [IO.Path]::GetRelativePath([IO.Path]::GetFullPath($Root), [IO.Path]::GetFullPath($Child))
  return $relative -ne '.' -and -not $relative.StartsWith('..') -and -not [IO.Path]::IsPathRooted($relative)
}

$Protected = @(
  [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($HOME)),
  [IO.Path]::GetFullPath($HOME),
  [IO.Path]::GetFullPath($WorkspaceRoot)
)

$Inventory = foreach ($candidate in $Candidates) {
  $canonical = Get-CanonicalPath $candidate.InputPath
  $final = Get-FinalPath $candidate.InputPath
  $allowed = Get-FinalPath $candidate.AllowedRoot

  foreach ($protected in $Protected) {
    if ($final -eq [IO.Path]::GetPathRoot($final)) {
      throw "拒绝盘符根: $final"
    }
    if ($final -eq $protected -or (Test-IsInside $protected $final)) {
      throw "拒绝根目录、HOME、workspace root 或其祖先: $final"
    }
  }
  if (-not (Test-IsInside $final $allowed)) {
    throw "最终路径不在确认的允许根内: $final ; allowed=$allowed"
  }

  [pscustomobject]@{
    Name = $candidate.Name
    InputPath = $candidate.InputPath
    CanonicalPath = $canonical
    FinalPath = $final
    AllowedRoot = $allowed
    Exists = Test-Path -LiteralPath $canonical
    Recoverable = $candidate.Recoverable
  }
}

$Inventory | Format-Table -AutoSize
$Inventory | ConvertTo-Json -Depth 4
```

逐行检查输出中的输入路径、规范绝对路径、symlink/junction 最终路径、允许根、存在状态和可恢复性。只要有一个路径不明确、指向共享目录或跨出允许根，就停止。

## 3. 停进程并二次验证

手工退出 Desktop、CLI、daemon，以及由它们启动的后台进程。确认没有 OpenHarness 进程仍持有数据库或目录后，原样再次运行第 2 节脚本，并比较两次 `$Inventory | ConvertTo-Json` 输出。

只有路径集合、CanonicalPath、FinalPath 和 AllowedRoot 全部未变化才继续。任何变化都视为检查与操作之间的路径竞态，需要重新开始预检。

## 4. 逐项授权

把最终 `$Inventory` 展示给用户，并对每一行分别取得明确授权，例如：

```text
[ ] settings — C:\精确路径\settings.json — 最终目标 C:\精确路径\settings.json — 不可恢复
[ ] runtime-data — C:\精确路径\data — 最终目标 C:\精确路径\data — 不可恢复
```

未勾选的项不得操作。“重置 OpenHarness”这种整体表述不代替逐项授权。

获得授权后，只能手工把某一行已经复核的精确最终路径填入 `-LiteralPath`。文件示例：

```powershell
Remove-Item -LiteralPath 'C:\已经逐项授权的精确文件路径' -Force
```

本文不提供通配符或递归删除示例。非空目录必须先列出其精确内容并另行选择安全、可审核的处理方式；不得把变量、glob 或用户目录直接代入删除命令。

## 5. 删除后证明与全新启动

对每个已授权目标分别运行 `Test-Path -LiteralPath '<精确路径>'`，预期为 `False`。然后使用新的空目录启动当前版本，确认生成协议版本 4 所用配置和单一数据库基线。

最终记录必须分开写：

- **代码状态：** verifier、测试、构建是否通过或因环境依赖阻断。
- **本机数据状态：** `尚未授权/尚未重置`，或列出每个已授权且已证明不存在的精确路径。

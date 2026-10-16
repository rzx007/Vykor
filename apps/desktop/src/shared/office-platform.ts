export function supportsBundledOfficePlugin(platform: string, arch: string): boolean {
  return ["win32-x64", "darwin-arm64", "linux-x64"].includes(`${platform}-${arch}`)
}

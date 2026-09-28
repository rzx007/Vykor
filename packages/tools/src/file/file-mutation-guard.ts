// System directories that must never be written to, regardless of permission mode.
// Shared by Write/Edit/ApplyPatch so the directory table lives in exactly one place.
export const SYSTEM_DIR_PREFIXES = [
  "/etc/", "/sys/", "/proc/", "/dev/", "/boot/",
  "/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/",
  "c:\\windows\\", "c:\\program files\\", "c:\\program files (x86)\\",
];

export function isSystemPath(p: string): boolean {
  const normalized = p.replace(/\\/g, "/").toLowerCase();
  return SYSTEM_DIR_PREFIXES.some((prefix) => normalized.startsWith(prefix.replace(/\\/g, "/")));
}

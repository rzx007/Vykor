import { posix, win32 } from "node:path";

// System directories that must never be written to, regardless of permission mode.
// Shared by Write/Edit/ApplyPatch so the directory table lives in exactly one place.
export const SYSTEM_DIR_PREFIXES = [
  "/etc/", "/sys/", "/proc/", "/dev/", "/boot/",
  "/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/",
  "c:\\windows\\", "c:\\program files\\", "c:\\program files (x86)\\",
];

export function isSystemPath(p: string): boolean {
  const path = p.replace(/\\/g, "/").toLowerCase().replace(/^\/\/\?\/(?=[a-z]:\/)/, "");
  const normalized = (/^[a-z]:\//.test(path) ? win32.normalize(path).replace(/\\/g, "/") : posix.normalize(path)).replace(/\/$/, "");
  return SYSTEM_DIR_PREFIXES.some(prefix => {
    const directory = prefix.replace(/\\/g, "/").replace(/\/$/, "");
    return normalized === directory || normalized.startsWith(`${directory}/`);
  });
}

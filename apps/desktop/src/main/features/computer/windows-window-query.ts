// The operating system is queried through one hidden PowerShell process. This
// code enumerates windows and reads process metadata without sending input.
export const windowsWindowQuery = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class VykorWindowsWindowQuery
{
    private delegate bool Enumerate(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Enumerate callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, Enumerate callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint relation);
    [DllImport("user32.dll")] private static extern IntPtr GetLastActivePopup(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder data, uint length, out uint required);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
    [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
    [DllImport("kernel32.dll")] private static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr handle, int flags, StringBuilder image, ref int size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int GetApplicationUserModelId(IntPtr handle, ref uint length, StringBuilder appId);
    [DllImport("advapi32.dll")] private static extern bool OpenProcessToken(IntPtr handle, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] private static extern bool GetTokenInformation(IntPtr token, int information, out uint value, int length, out uint used);

    public sealed class Window
    {
        public long windowId { get; set; }
        public long? ownerWindowId { get; set; }
        public uint pid { get; set; }
        public uint threadId { get; set; }
        public uint sessionId { get; set; }
        public long processStartedAt { get; set; }
        public string processStartKey { get; set; }
        public uint applicationPid { get; set; }
        public string applicationStartKey { get; set; }
        public string title { get; set; }
        public string document { get; set; }
        public Position position { get; set; }
        public bool blocked { get; set; }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }
    public sealed class Position { public int left { get; set; } public int top { get; set; } }

    public sealed class Result
    {
        public readonly List<Window> windows = new List<Window>();
        public bool restricted;
        public bool desktopAvailable;
    }

    private sealed class Identity
    {
        public uint pid;
        public uint session;
        public long created;
        public string appId;
        public string image;
        public bool allowed;
    }

    private static bool ReadDesktop()
    {
        var desktop = OpenInputDesktop(0, false, 1); // DESKTOP_READOBJECTS
        if (desktop == IntPtr.Zero) return false;
        try {
            var name = new StringBuilder(128);
            uint required;
            return GetUserObjectInformation(desktop, 2, name, 256, out required)
                && String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
        } finally {
            CloseDesktop(desktop);
        }
    }

    private static bool CanUseToken(IntPtr process, SecurityIdentifier user)
    {
        IntPtr token;
        if (!OpenProcessToken(process, 8, out token)) return false; // TOKEN_QUERY
        try {
            uint elevated, uiAccess, used;
            if (!GetTokenInformation(token, 20, out elevated, 4, out used) || elevated != 0 ||
                !GetTokenInformation(token, 26, out uiAccess, 4, out used) || uiAccess != 0) return false;
            using (var identity = new WindowsIdentity(token))
                return user.Equals(identity.User);
        } finally {
            CloseHandle(token);
        }
    }

    private static Identity ReadIdentity(uint pid, uint session, SecurityIdentifier user)
    {
        uint processSession;
        if (!ProcessIdToSessionId(pid, out processSession) || processSession != session) return null;
        var handle = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (handle == IntPtr.Zero) return null;
        try {
            long created, other;
            if (!GetProcessTimes(handle, out created, out other, out other, out other)) return null;
            var filename = new StringBuilder(32768);
            int size = filename.Capacity;
            if (!QueryFullProcessImageName(handle, 0, filename, ref size)) return null;
            var appId = new StringBuilder(512);
            uint length = (uint)appId.Capacity;
            return new Identity {
                pid = pid, session = session, created = created, image = filename.ToString(),
                appId = GetApplicationUserModelId(handle, ref length, appId) == 0 ? appId.ToString() : "",
                allowed = CanUseToken(handle, user)
            };
        } finally {
            CloseHandle(handle);
        }
    }

    public static Result Scan(string application, string executable, string frameImage, bool explorer)
    {
        var result = new Result { desktopAvailable = ReadDesktop() };
        if (!result.desktopAvailable) return result;
        bool sharePicker = String.IsNullOrEmpty(application) && String.IsNullOrEmpty(executable);
        uint session = (uint)Process.GetCurrentProcess().SessionId;
        var user = WindowsIdentity.GetCurrent().User;
        var cache = new Dictionary<uint, Identity>();
        Func<uint, Identity> read = delegate(uint pid) {
            Identity found;
            if (!cache.TryGetValue(pid, out found)) {
                found = ReadIdentity(pid, session, user);
                cache.Add(pid, found);
            }
            return found;
        };
        var windows = new Dictionary<long, Window>();
        EnumWindows(delegate(IntPtr handle, IntPtr ignored) {
            if (!IsWindowVisible(handle) || (sharePicker && IsIconic(handle))) return true;
            int cloaked;
            if (DwmGetWindowAttribute(handle, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
            uint pid;
            uint thread = GetWindowThreadProcessId(handle, out pid);
            if (pid == 0 || thread == 0) return true;
            var windowProcess = read(pid);
            if (windowProcess == null) return true;
            var owner = GetWindow(handle, 4); // GW_OWNER
            var className = new StringBuilder(128);
            GetClassName(handle, className, className.Capacity);
            if (sharePicker && (className.ToString() == "Progman" || className.ToString() == "WorkerW" ||
                className.ToString() == "Shell_TrayWnd" || className.ToString() == "Shell_SecondaryTrayWnd")) return true;
            Identity appProcess = null;
            if (!String.IsNullOrEmpty(executable)) {
                if (!String.Equals(windowProcess.image, executable, StringComparison.OrdinalIgnoreCase)) return true;
                if (explorer && owner == IntPtr.Zero && className.ToString() != "CabinetWClass"
                    && className.ToString() != "ExploreWClass") return true;
                appProcess = windowProcess;
            } else if (!sharePicker && String.Equals(windowProcess.appId, application, StringComparison.OrdinalIgnoreCase)) {
                appProcess = windowProcess;
            } else if (className.ToString() == "ApplicationFrameWindow" &&
                String.Equals(windowProcess.image, frameImage, StringComparison.OrdinalIgnoreCase)) {
                var children = new Dictionary<uint, Identity>();
                EnumChildWindows(handle, delegate(IntPtr child, IntPtr unused) {
                    uint childPid;
                    GetWindowThreadProcessId(child, out childPid);
                    if (childPid != 0 && childPid != pid && IsWindowVisible(child)) {
                        var identity = read(childPid);
                        if (identity != null && (sharePicker ? !String.IsNullOrEmpty(identity.appId)
                            : String.Equals(identity.appId, application, StringComparison.OrdinalIgnoreCase)))
                            children[childPid] = identity;
                    }
                    return true;
                }, IntPtr.Zero);
                if (children.Count == 1) foreach (var child in children.Values) appProcess = child;
            } else if (sharePicker) appProcess = windowProcess;
            if (appProcess == null) return true;
            if (!appProcess.allowed || !windowProcess.allowed) {
                result.restricted = true;
                return true;
            }
            var title = new StringBuilder(512);
            if (GetWindowText(handle, title, title.Capacity) == 0 || String.IsNullOrWhiteSpace(title.ToString()))
                return true;
            uint stillPid;
            if (GetWindowThreadProcessId(handle, out stillPid) != thread || stillPid != pid) return true;
            Rect rect;
            var position = GetWindowRect(handle, out rect) ? new Position { left = rect.Left, top = rect.Top } : null;
            windows.Add(handle.ToInt64(), new Window {
                windowId = handle.ToInt64(), pid = pid, threadId = thread, sessionId = windowProcess.session,
                processStartKey = windowProcess.created.ToString(),
                processStartedAt = (windowProcess.created - 116444736000000000L) / 10000,
                applicationPid = appProcess.pid, applicationStartKey = appProcess.created.ToString(),
                ownerWindowId = owner == IntPtr.Zero ? (long?)null : owner.ToInt64(),
                title = title.ToString(), position = position
            });
            return true;
        }, IntPtr.Zero);
        foreach (var window in windows.Values) {
            if (window.ownerWindowId.HasValue) {
                Window owner;
                // An unrelated owned tool window or a protected popup never inherits permission.
                if (!windows.TryGetValue(window.ownerWindowId.Value, out owner) ||
                    owner.applicationPid != window.applicationPid ||
                    owner.applicationStartKey != window.applicationStartKey ||
                    IsWindowEnabled(new IntPtr(owner.windowId)) ||
                    GetLastActivePopup(new IntPtr(owner.windowId)).ToInt64() != window.windowId)
                    continue;
            }
            result.windows.Add(window);
        }
        foreach (var window in result.windows) {
            window.blocked = !IsWindowEnabled(new IntPtr(window.windowId)) &&
                !result.windows.Exists(candidate => candidate.ownerWindowId == window.windowId &&
                    IsWindowEnabled(new IntPtr(candidate.windowId)));
        }
        return result;
    }
}
`;

export const windowsActivatePackagedApp = String.raw`
using System;
using System.Runtime.InteropServices;

public static class VykorPackagedApp
{
    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    private class ActivationManager {}

    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivationManager
    {
        void ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string app,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint pid);
    }

    public static void Activate(string app)
    {
        var manager = (IActivationManager)new ActivationManager();
        try {
            uint pid;
            manager.ActivateApplication(app, null, 0, out pid);
        } finally {
            Marshal.FinalReleaseComObject(manager);
        }
    }
}
`;

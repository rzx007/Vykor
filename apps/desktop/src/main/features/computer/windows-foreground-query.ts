import { windowsAuthenticationQuery } from "./windows-authentication-query"

// One owned Windows PowerShell child provides exact-window capture or an input lease.
// The hooks stop on external input and gate each tagged mouse gesture event at the OS queue.
export const windowsForegroundQuery = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

${windowsAuthenticationQuery}

public sealed class VykorWindowsForeground
{
    [StructLayout(LayoutKind.Sequential)] internal struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct MonitorInfo {
        public int Size; public Rect Bounds, Work; public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
    }
    [StructLayout(LayoutKind.Sequential)] struct GuiInfo {
        public int Size; public uint Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret; public Rect CaretRect;
    }
    [StructLayout(LayoutKind.Sequential)] struct KeyboardHook { public int Key, Scan; public uint Flags, Time; public UIntPtr Tag; }
    [StructLayout(LayoutKind.Sequential)] struct MouseHook { public Point Point; public uint Data, Flags, Time; public UIntPtr Tag; }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Tag; }
    [StructLayout(LayoutKind.Sequential)] struct KeyInput { public ushort Key, Scan; public uint Flags, Time; public UIntPtr Tag; }
    [StructLayout(LayoutKind.Explicit)] struct InputData {
        [FieldOffset(0)] public MouseInput Mouse;
        [FieldOffset(0)] public KeyInput Key;
    }
    [StructLayout(LayoutKind.Sequential)] struct NativeInput { public uint Type; public InputData Data; }
    delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    delegate void ForegroundEvent(IntPtr hook, uint kind, IntPtr window, int objectId, int childId, uint thread, uint time);

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint relation);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out int pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder title, int size);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr window, out uint affinity);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint value, out uint result, uint flags);
    [DllImport("user32.dll")] static extern uint SendInput(uint count, NativeInput[] input, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message,
        IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int kind, Hook callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, ForegroundEvent callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder text, uint size, out uint required);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect rect, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetInt(IntPtr window, int attribute, out int value, int size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);

    public sealed class Target {
        public long hwnd { get; set; } public long owner { get; set; }
        public int pid { get; set; } public int app { get; set; } public uint thread { get; set; }
        public int session { get; set; } public string started { get; set; }
        public string appStarted { get; set; } public string title { get; set; }
        internal IntPtr Window { get { return new IntPtr(hwnd); } }
        internal bool Owns(IntPtr handle) {
            if (handle == IntPtr.Zero || handle == new IntPtr(0xffff) || GetAncestor(handle, 2) != Window) return false;
            int process;
            return GetWindowThreadProcessId(handle, out process) != 0 && (process == pid || process == app);
        }
        internal bool Matches(bool mayBeMinimized) {
            int process, cloak;
            if (!IsWindowVisible(Window) || !IsWindowEnabled(Window) || (!mayBeMinimized && IsIconic(Window)) ||
                GetWindow(Window, 4).ToInt64() != owner || GetWindowThreadProcessId(Window, out process) != thread || process != pid ||
                (DwmGetInt(Window, 14, out cloak, 4) == 0 && cloak != 0)) return false;
            uint affinity;
            if (GetWindowDisplayAffinity(Window, out affinity) && affinity != 0) return false;
            var titleBuffer = new StringBuilder(512);
            GetWindowText(Window, titleBuffer, titleBuffer.Capacity);
            return !VykorWindowsAuthentication.SensitiveCaption(titleBuffer.ToString()) && String.Equals(titleBuffer.ToString(), title, StringComparison.Ordinal)
                && ProcessMatches(pid, session, started) && ProcessMatches(app, session, appStarted);
        }
    }
    public sealed class Geometry {
        public int left { get; set; } public int top { get; set; }
        public int width { get; set; } public int height { get; set; }
        public uint dpi { get; set; } public string monitor { get; set; }
        internal bool Matches(Geometry g) {
            return g != null && left == g.left && top == g.top && width == g.width && height == g.height && dpi == g.dpi && monitor == g.monitor;
        }
        internal bool Contains(Point p) { return p.X >= left && p.Y >= top && p.X < left + width && p.Y < top + height; }
    }
    public sealed class Command {
        public int id { get; set; } public string type { get; set; } public int x { get; set; } public int y { get; set; }
        public int key { get; set; } public int[] modifiers { get; set; } public string button { get; set; }
        public int count { get; set; } public int toX { get; set; } public int toY { get; set; }
        public int delta { get; set; } public bool horizontal { get; set; }
        public string text { get; set; } public string focusIdentity { get; set; }
        public Geometry geometry { get; set; } public string signature { get; set; }
        public CaptureRegion region { get; set; }
        public int imageWidth { get; set; } public int imageHeight { get; set; }
        public Patch[] patches { get; set; }
        internal bool holdRelease;
    }
    public sealed class CaptureRegion {
        public int x { get; set; } public int y { get; set; }
        public int width { get; set; } public int height { get; set; }
        internal bool Fits(Geometry g) {
            return width > 0 && height > 0 && x >= 0 && y >= 0 && x <= g.width - width && y <= g.height - height;
        }
        internal bool Contains(Geometry g, Point p) {
            return p.X >= g.left + x && p.Y >= g.top + y && p.X < g.left + x + width && p.Y < g.top + y + height;
        }
    }
    public sealed class Crop {
        public Geometry geometry { get; set; }
        public CaptureRegion region { get; set; }
    }
    public sealed class Patch {
        public int left { get; set; } public int top { get; set; }
        public int width { get; set; } public int height { get; set; }
        public string digest { get; set; }
    }
    sealed class Frame {
        public string mimeType { get { return "image/png"; } }
        public string data { get; set; } public int width { get; set; } public int height { get; set; }
        public string signature { get; set; } public Geometry geometry { get; set; }
        public CaptureRegion region { get; set; }
        public string focusIdentity { get; set; }
    }
    static bool ProcessMatches(int pid, int session, string started) {
        try {
            using (var p = Process.GetProcessById(pid))
                return p.SessionId == session && p.StartTime.ToFileTimeUtc().ToString(CultureInfo.InvariantCulture) == started;
        } catch { return false; }
    }
    static bool DefaultDesktop() {
        var surface = OpenInputDesktop(0, false, 1);
        if (surface == IntPtr.Zero) return false;
        try {
            var name = new StringBuilder(128); uint needed;
            return GetUserObjectInformation(surface, 2, name, 256, out needed) && name.ToString() == "Default";
        } finally { CloseDesktop(surface); }
    }
    static Geometry Locate(Target target, out Rect raw) {
        raw = new Rect();
        if (!GetWindowRect(target.Window, out raw)) return null;
        Rect bounds;
        if (DwmGetWindowAttribute(target.Window, 9, out bounds, Marshal.SizeOf(typeof(Rect))) != 0) bounds = raw;
        if (bounds.Left < raw.Left || bounds.Top < raw.Top || bounds.Right > raw.Right || bounds.Bottom > raw.Bottom) return null;
        int width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top;
        uint dpi = GetDpiForWindow(target.Window);
        if (dpi == 0 || width <= 0 || height <= 0 || raw.Right - raw.Left > 7680 || raw.Bottom - raw.Top > 4320) return null;
        var display = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
        string monitor = "";
        if (GetMonitorInfo(MonitorFromWindow(target.Window, 0), ref display) && bounds.Left >= display.Bounds.Left && bounds.Top >= display.Bounds.Top &&
            bounds.Right <= display.Bounds.Right && bounds.Bottom <= display.Bounds.Bottom)
            monitor = display.Device + "|" + display.Bounds.Left + "|" + display.Bounds.Top + "|" + display.Bounds.Right + "|" + display.Bounds.Bottom;
        return new Geometry { left = bounds.Left, top = bounds.Top, width = width, height = height, dpi = dpi, monitor = monitor };
    }
    static bool ClearForCapture(AutomationElement root, Target target, ref int left, int depth) {
        if (root == null || --left <= 0 || depth > 24) return false;
        var current = root.Current;
        if (current.ProcessId != target.pid && current.ProcessId != target.app) return false;
        var walker = TreeWalker.ControlViewWalker;
        for (var child = walker.GetFirstChild(root); child != null; child = walker.GetNextSibling(child))
            if (!ClearForCapture(child, target, ref left, depth + 1)) return false;
        return true;
    }
    static bool ClearForInput(Target target) {
        int budget = 1000;
        return VykorWindowsAuthentication.Clear(AutomationElement.FromHandle(target.Window), ref budget, 0);
    }
    static Frame Capture(Target target, Crop detail = null, int observedWidth = 0, int observedHeight = 0) {
        if (!DefaultDesktop() || !target.Matches(false) || !ClearForInput(target)) return null;
        int budget = 320;
        if (!ClearForCapture(AutomationElement.FromHandle(target.Window), target, ref budget, 0)) return null;
        var focus = ContentFocus(target, false);
        Rect before;
        var geometry = Locate(target, out before);
        if (geometry == null) return null;
        bool rechecking = observedWidth > 0 && observedHeight > 0;
        if (observedWidth > 1600 || observedHeight > 1600) return null;
        var region = detail == null ? new CaptureRegion { width = geometry.width, height = geometry.height } : detail.region;
        if (detail != null && (!geometry.Matches(detail.geometry) || region == null || !region.Fits(geometry) ||
            Math.Max(region.width, region.height) > 1600)) return null;
        using (var source = new Bitmap(before.Right - before.Left, before.Bottom - before.Top, PixelFormat.Format24bppRgb)) {
            using (var graphics = Graphics.FromImage(source)) {
                var dc = graphics.GetHdc();
                try { if (!PrintWindow(target.Window, dc, 2)) return null; }
                finally { graphics.ReleaseHdc(dc); }
            }
            Rect after;
            budget = 320;
            if (!DefaultDesktop() || !target.Matches(false) || !geometry.Matches(Locate(target, out after)) ||
                !ClearForCapture(AutomationElement.FromHandle(target.Window), target, ref budget, 0) || !ClearForInput(target)) return null;
            var afterFocus = ContentFocus(target, false);
            var crop = new Rectangle(geometry.left - before.Left + region.x, geometry.top - before.Top + region.y, region.width, region.height);
            for (int edge = 1600; edge >= 400; edge /= 2) {
                double scale = Math.Min(1, (double)edge / Math.Max(region.width, region.height));
                int width = rechecking ? observedWidth : Math.Max(1, (int)Math.Round(region.width * scale));
                int height = rechecking ? observedHeight : Math.Max(1, (int)Math.Round(region.height * scale));
                using (var image = new Bitmap(width, height, PixelFormat.Format24bppRgb))
                using (var stream = new MemoryStream()) {
                    using (var graphics = Graphics.FromImage(image))
                        graphics.DrawImage(source, new Rectangle(0, 0, width, height), crop, GraphicsUnit.Pixel);
                    image.Save(stream, ImageFormat.Png);
                    if (!rechecking && stream.Length > 768 * 1024) {
                        if (detail != null) return null;
                        continue;
                    }
                    var bytes = stream.ToArray();
                    using (var sha = SHA256.Create())
                        return new Frame { width = width, height = height, geometry = geometry, region = detail == null ? null : region, data = Convert.ToBase64String(bytes),
                            focusIdentity = SameFocus(focus, afterFocus) ? focus.identity : null,
                            signature = Convert.ToBase64String(sha.ComputeHash(bytes)) };
                }
            }
        }
        return null;
    }

    readonly Target target;
    readonly string testFault;
    readonly List<Delivery> held = new List<Delivery>();
    readonly object output = new object(), dispatch = new object();
    readonly Hook keyHook, mouseHook;
    readonly ForegroundEvent foregroundHook;
    readonly ManualResetEvent starting = new ManualResetEvent(false), cancelled = new ManualResetEvent(false);
    IntPtr keyboard, pointer, focusWatch;
    Control pump;
    volatile bool stopping, ready, releaseUnverified, pointerHeld;
    bool revocationReported;
    string reason;
    int inFlight;
    readonly UIntPtr inputTag = new UIntPtr((BitConverter.ToUInt32(Guid.NewGuid().ToByteArray(), 0) & 0x7fffffffu) | 1u);
    volatile Delivery injecting;

    sealed class Delivery {
        public IntPtr handle, wParam, lParam;
        public uint message;
        public Delivery Up;
        public bool Releases, MoveWhileHeld, Unconfirmed;
        public Point? Pointer;
        public NativeInput? Native;
        public int SettleMs;
        public int ReleaseKey;
        public TaskCompletionSource<bool> Accepted;
    }
    sealed class Focus {
        public IntPtr handle;
        public string identity;
    }

    VykorWindowsForeground(Target target, string testFault) {
        this.target = target;
        this.testFault = testFault;
        keyHook = delegate(int code, IntPtr message, IntPtr data) {
            if (code >= 0) {
                var key = (KeyboardHook)Marshal.PtrToStructure(data, typeof(KeyboardHook));
                if (key.Tag == inputTag && (key.Flags & 16) != 0) {
                    if (!AcceptTagged(null)) return new IntPtr(1);
                    return CallNextHookEx(IntPtr.Zero, code, message, data);
                }
                if ((key.Flags & 128) == 0) {
                    if (key.Key == 27 && ready && !stopping && !revocationReported) {
                        Interlocked.Exchange(ref reason, "emergency_stop");
                        cancelled.Set();
                        return new IntPtr(1);
                    }
                    Revoke("physical_input");
                }
            }
            return CallNextHookEx(IntPtr.Zero, code, message, data);
        };
        mouseHook = delegate(int code, IntPtr message, IntPtr data) {
            if (code >= 0) {
                var mouse = (MouseHook)Marshal.PtrToStructure(data, typeof(MouseHook));
                if (mouse.Tag == inputTag && (mouse.Flags & 1) != 0) {
                    if (!AcceptTagged(mouse.Point)) return new IntPtr(1);
                } else {
                    Revoke("physical_input");
                    // Don't move a still-held synthetic drag onto another app during takeover.
                    if (pointerHeld && message.ToInt64() == 0x200) return new IntPtr(1);
                }
            }
            return CallNextHookEx(IntPtr.Zero, code, message, data);
        };
        foregroundHook = delegate(IntPtr h, uint e, IntPtr w, int objectId, int childId, uint t, uint now) {
            if (ready && w != target.Window) Revoke("focus_lost");
        };
    }
    void Write(object row) {
        // Only protocol replies go to the owned pipe. Commands and raw input are never echoed.
        var line = new JavaScriptSerializer { MaxJsonLength = 1500000 }.Serialize(row);
        lock (output) { Console.WriteLine(line); Console.Out.Flush(); }
    }
    void Revoke(string code) {
        Interlocked.CompareExchange(ref reason, code, null);
        cancelled.Set();
    }
    string Reason { get { return Volatile.Read(ref reason); } }
    bool AtTarget() { return GetForegroundWindow() == target.Window; }
    bool Allowed() { return !stopping && Reason == null && AtTarget() && DefaultDesktop(); }
    bool AcceptTagged(Point? cursor) {
        var input = injecting;
        if (input == null) return false;
        bool accepted = input.Releases;
        if (!accepted && input.Pointer.HasValue && Allowed()) {
            var expected = input.Pointer.Value;
            var actual = cursor.GetValueOrDefault();
            var info = new GuiInfo { Size = Marshal.SizeOf(typeof(GuiInfo)) };
            if ((cursor.HasValue || GetCursorPos(out actual)) && actual.X == expected.X && actual.Y == expected.Y &&
                GetGUIThreadInfo(target.thread, ref info)) {
                var hit = WindowFromPoint(actual);
                accepted = input.MoveWhileHeld ? target.Owns(hit) && (info.Capture == IntPtr.Zero || target.Owns(info.Capture))
                    : hit == input.handle && target.Owns(hit) && (info.Capture == IntPtr.Zero || info.Capture == hit);
            }
        }
        input.Accepted.TrySetResult(accepted);
        return accepted;
    }
    static bool Down(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
    static bool ExistingInput() {
        foreach (int button in new[] { 1, 2, 4, 5, 6 }) if (Down(button)) return true;
        for (int key = 8; key < 255; key++) if (Down(key)) return true;
        return false;
    }
    static Focus ContentFocus(Target target, bool requireNativeEditor) {
        var info = new GuiInfo { Size = Marshal.SizeOf(typeof(GuiInfo)) };
        if (GetForegroundWindow() != target.Window || !GetGUIThreadInfo(target.thread, ref info) || !target.Owns(info.Focus)) return null;
        var element = AutomationElement.FocusedElement;
        if (element == null) return null;
        var current = element.Current;
        var name = current.Name;
        if ((current.ProcessId != target.pid && current.ProcessId != target.app) || !current.HasKeyboardFocus ||
            !current.IsEnabled || VykorWindowsAuthentication.SensitiveCaption(name) ||
            VykorWindowsAuthentication.SensitiveField(current.IsPassword, name, current.AutomationId, current.HelpText)) return null;
        if (requireNativeEditor && ((current.ControlType != ControlType.Edit && current.ControlType != ControlType.Document) ||
            new IntPtr(current.NativeWindowHandle) != info.Focus)) return null;
        var identity = element.GetRuntimeId();
        var after = new GuiInfo { Size = Marshal.SizeOf(typeof(GuiInfo)) };
        return identity != null && identity.Length > 0 && GetForegroundWindow() == target.Window && GetGUIThreadInfo(target.thread, ref after) &&
            after.Focus == info.Focus ? new Focus { handle = info.Focus, identity = String.Join(",", identity) } : null;
    }
    static bool SameFocus(Focus first, Focus next) {
        return first != null && next != null && first.handle == next.handle && first.identity == next.identity;
    }
    bool StillFocused(Focus expected) {
        if (expected == null) return true;
        var info = new GuiInfo { Size = Marshal.SizeOf(typeof(GuiInfo)) };
        return GetGUIThreadInfo(target.thread, ref info) && info.Focus == expected.handle;
    }
    IntPtr ClickTarget(Point point) {
        var window = WindowFromPoint(point);
        var info = new GuiInfo { Size = Marshal.SizeOf(typeof(GuiInfo)) };
        if (!target.Owns(window) || !GetGUIThreadInfo(target.thread, ref info) ||
            (info.Capture != IntPtr.Zero && info.Capture != window)) return IntPtr.Zero;
        var element = AutomationElement.FromPoint(new System.Windows.Point(point.X, point.Y));
        if (element == null) return IntPtr.Zero;
        var current = element.Current;
        var name = current.Name;
        return ((current.ProcessId == target.pid || current.ProcessId == target.app) && current.IsEnabled &&
            !VykorWindowsAuthentication.SensitiveCaption(name) &&
            !VykorWindowsAuthentication.SensitiveField(current.IsPassword, name, current.AutomationId, current.HelpText))
            ? window : IntPtr.Zero;
    }
    static Delivery Message(IntPtr handle, uint message, int wParam, int lParam) {
        return new Delivery { handle = handle, message = message, wParam = new IntPtr(wParam), lParam = new IntPtr(lParam) };
    }
    static Delivery Key(IntPtr handle, int key, bool system) {
        int flags = unchecked((int)(1u | ((MapVirtualKey((uint)key, 0) & 255u) << 16) |
            (key >= 33 && key <= 46 ? 1u << 24 : 0u) | (system && key != 18 ? 1u << 29 : 0u)));
        var down = Message(handle, system ? 0x104u : 0x100u, key, flags);
        down.Up = Message(handle, system ? 0x105u : 0x101u, key, flags | unchecked((int)0xc0000000u));
        return down;
    }
    static bool MatchesPointerEvidence(Command action, Frame current) {
        if (current == null || !action.geometry.Matches(current.geometry) ||
            current.width != action.imageWidth || current.height != action.imageHeight) return false;
        if (current.signature == action.signature) return true;
        if (action.patches == null || action.patches.Length != (action.type == "drag" ? 2 : 1)) return false;
        using (var stream = new MemoryStream(Convert.FromBase64String(current.data)))
        using (var image = new Bitmap(stream))
        using (var sha = SHA256.Create()) {
            foreach (var patch in action.patches) {
                if (patch == null || patch.width < 1 || patch.width > 33 || patch.height < 1 || patch.height > 33 ||
                    patch.left < 0 || patch.top < 0 || patch.left > image.Width - patch.width ||
                    patch.top > image.Height - patch.height) return false;
                var bytes = new byte[patch.width * patch.height * 3];
                int n = 0;
                for (int y = patch.top; y < patch.top + patch.height; y++)
                    for (int x = patch.left; x < patch.left + patch.width; x++) {
                        var pixel = image.GetPixel(x, y);
                        bytes[n++] = pixel.R; bytes[n++] = pixel.G; bytes[n++] = pixel.B;
                    }
                if (Convert.ToBase64String(sha.ComputeHash(bytes)) != patch.digest) return false;
            }
            return true;
        }
    }
    Delivery Mouse(IntPtr handle, Point point, uint flags, int delta = 0, int x = 0, int y = 0) {
        return new Delivery { handle = handle, Pointer = point, Native = new NativeInput {
            Data = new InputData { Mouse = new MouseInput { X = x, Y = y, Flags = flags, Data = unchecked((uint)delta), Tag = inputTag } }
        } };
    }
    Delivery Move(IntPtr handle, Point point) {
        int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        int x = point.X - GetSystemMetrics(76), y = point.Y - GetSystemMetrics(77);
        if (width <= 0 || height <= 0 || x < 0 || x >= width || y < 0 || y >= height) return null;
        return Mouse(handle, point, 0xe001u, 0, (int)Math.Ceiling(x * 65536d / width), (int)Math.Ceiling(y * 65536d / height));
    }
    Delivery MousePress(IntPtr handle, Point point, bool left) {
        var down = Mouse(handle, point, left ? 2u : 8u);
        down.Up = Mouse(handle, point, left ? 4u : 16u);
        down.Up.Releases = true; down.Up.ReleaseKey = left ? 1 : 2;
        return down;
    }
    Delivery ModifierPress(IntPtr handle, Point point, ushort key) {
        var down = new NativeInput { Type = 1, Data = new InputData { Key = new KeyInput { Key = key, Tag = inputTag } } };
        var up = down; up.Data.Key.Flags = 2;
        return new Delivery { handle = handle, Pointer = point, Native = down,
            Up = new Delivery { handle = handle, Native = up, Releases = true, ReleaseKey = key } };
    }
    List<Delivery> BuildPointer(Command action) {
        var from = new Point { X = action.x, Y = action.y };
        var detail = action.region == null ? null : new Crop { region = action.region, geometry = action.geometry };
        if (action.geometry == null || !action.geometry.Contains(from) || String.IsNullOrEmpty(action.signature) ||
            (detail != null && !detail.region.Contains(action.geometry, from)) ||
            !MatchesPointerEvidence(action, Capture(target, detail, action.imageWidth, action.imageHeight))) return null;
        var handle = ClickTarget(from);
        if (handle == IntPtr.Zero) return null;
        var moveToStart = Move(handle, from);
        if (moveToStart == null) return null;
        var inputs = new List<Delivery> { moveToStart };
        if (action.type == "hover") return inputs;
        if (action.type == "scroll_at") {
            if (action.delta == 0 || action.delta < -600 || action.delta > 600 || action.delta % 120 != 0) return null;
            uint routing;
            if (!action.horizontal && SystemParametersInfo(0x201c, 0, out routing, 0) && routing == 2) {
                inputs.Add(Mouse(handle, from, 0x0800u, action.delta));
            } else {
                if (from.X < Int16.MinValue || from.X > Int16.MaxValue || from.Y < Int16.MinValue || from.Y > Int16.MaxValue) return null;
                var wheel = Message(handle, action.horizontal ? 0x20eu : 0x20au, action.delta << 16, (from.Y << 16) | (from.X & 0xffff));
                wheel.Pointer = from;
                inputs.Add(wheel);
            }
            return inputs;
        }
        if (action.type == "drag") {
            var to = new Point { X = action.toX, Y = action.toY };
            if (!action.geometry.Contains(to) || (from.X == to.X && from.Y == to.Y) || ClickTarget(to) == IntPtr.Zero ||
                (detail != null && !detail.region.Contains(action.geometry, to))) return null;
            inputs.Add(MousePress(handle, from, true));
            const int steps = 12;
            for (int n = 1; n <= steps; n++) {
                var move = new Point { X = from.X + (to.X - from.X) * n / steps, Y = from.Y + (to.Y - from.Y) * n / steps };
                var next = Move(handle, move);
                if (next == null) return null;
                next.SettleMs = 25;
                next.MoveWhileHeld = true;
                inputs.Add(next);
            }
            return inputs;
        }
        if ((action.button != "left" && action.button != "right") || action.count < 0 || action.count > 2 ||
            (action.count == 2 && action.button != "left")) return null;
        foreach (int key in action.modifiers ?? new int[0]) {
            if (key != 16 && key != 17) return null;
            inputs.Add(ModifierPress(handle, from, (ushort)key));
        }
        var click = MousePress(handle, from, action.button == "left");
        inputs.Add(click);
        if (action.count == 2) {
            inputs.Add(click.Up);
            var second = MousePress(handle, from, true);
            second.SettleMs = 50;
            inputs.Add(second);
        }
        return inputs;
    }
    List<Delivery> Build(Command action, out Focus expectedFocus) {
        expectedFocus = null;
        if (action.type == "click" || action.type == "drag" || action.type == "scroll_at" || action.type == "hover") return BuildPointer(action);
        var inputs = new List<Delivery>();
        if (String.IsNullOrEmpty(action.focusIdentity) || !ClearForInput(target)) return null;
        expectedFocus = ContentFocus(target, action.type == "text");
        if (expectedFocus == null || expectedFocus.identity != action.focusIdentity) return null;
        var focused = expectedFocus.handle;
        if (action.type == "text" && !String.IsNullOrEmpty(action.text) && action.text.Length <= 1000) {
            foreach (char value in action.text) {
                if (Char.IsControl(value)) return null;
                inputs.Add(Message(focused, 0x102u, value, 1));
            }
        } else if (action.type == "key" && action.key > 0 && action.key <= 123 && action.modifiers != null && action.modifiers.Length <= 3) {
            bool system = Array.IndexOf(action.modifiers, 18) >= 0;
            foreach (int mod in action.modifiers) {
                if (mod != 16 && mod != 17 && mod != 18) return null;
                inputs.Add(Key(focused, mod, mod == 18));
            }
            inputs.Add(Key(focused, action.key, system));
        }
        return inputs.Count > 0 ? inputs : null;
    }
    bool RefreshInputHooks(bool first) {
        // Replace existing hooks before enabling a dispatch. Unhooking the old handles tells
        // us if Windows already discarded one. Neither validation nor dispatch injects global input.
        var module = GetModuleHandle(null);
        var newKeyboard = SetWindowsHookEx(13, keyHook, module, 0);
        var newPointer = SetWindowsHookEx(14, mouseHook, module, 0);
        var oldKeyboard = keyboard; var oldPointer = pointer;
        keyboard = newKeyboard; pointer = newPointer;
        bool hadKeyboard = oldKeyboard != IntPtr.Zero && UnhookWindowsHookEx(oldKeyboard);
        bool hadPointer = oldPointer != IntPtr.Zero && UnhookWindowsHookEx(oldPointer);
        return newKeyboard != IntPtr.Zero && newPointer != IntPtr.Zero && (first || (hadKeyboard && hadPointer));
    }
    bool ConfirmObservers() {
        var result = new TaskCompletionSource<bool>();
        try {
            pump.BeginInvoke((Action)delegate {
                result.TrySetResult(!stopping && Reason == null && RefreshInputHooks(false));
            });
            if (result.Task.Wait(600) && result.Task.Result) return true;
        } catch (InvalidOperationException) { }
        Revoke("driver_lost");
        return false;
    }
    bool Queue(Delivery input) {
        if (input.Native.HasValue) {
            var native = input.Native.Value;
            input.Accepted = new TaskCompletionSource<bool>();
            injecting = input;
            try {
                if (SendInput(1, new[] { native }, Marshal.SizeOf(typeof(NativeInput))) != 1) return false;
                if (!input.Accepted.Task.Wait(400)) {
                    input.Unconfirmed = true;
                    Revoke("driver_lost");
                    return false;
                }
                if (!input.Accepted.Task.Result) return false;
                if (input.ReleaseKey != 0) {
                    for (int i = 0; i < 10 && Down(input.ReleaseKey); i++) Thread.Sleep(5);
                    if (Down(input.ReleaseKey)) return false;
                    if (input.ReleaseKey <= 2) pointerHeld = false;
                }
                return true;
            } finally { injecting = null; }
        }
        return target.Owns(input.handle) && PostMessage(input.handle, input.message, input.wParam, input.lParam);
    }
    bool ReleaseHeld() {
        lock (dispatch) {
            for (int i = held.Count - 1; i >= 0; i--)
                if (Queue(held[i])) held.RemoveAt(i);
            return held.Count == 0;
        }
    }
    void CancelDrag() {
        var buttonUp = held.FindLast(input => input.ReleaseKey == 1);
        if (buttonUp == null || !target.Matches(false)) return;
        var info = new GuiInfo { Size = Marshal.SizeOf(typeof(GuiInfo)) };
        var receiver = GetGUIThreadInfo(target.thread, ref info) && target.Owns(info.Capture) ? info.Capture : buttonUp.handle;
        IntPtr ignored;
        if (target.Owns(receiver)) SendMessageTimeout(receiver, 0x1f, IntPtr.Zero, IntPtr.Zero, 2, 50, out ignored);
    }
    void Perform(Command action) {
        string state = "refused";
        int sent = 0;
        bool unconfirmed = false;
        bool released = true;
        try {
            SetThreadDpiAwarenessContext(new IntPtr(-4));
            if (!Allowed() || !target.Matches(false) || ExistingInput()) return;
            Focus expected;
            var inputs = Build(action, out expected);
            if (inputs == null || !Allowed() || !target.Matches(false) || ExistingInput()) return;
            if (inputs[0].Pointer.HasValue && inputs[0].handle != ClickTarget(inputs[0].Pointer.Value)) return;
            if (!ConfirmObservers() || !Allowed() || ExistingInput() || (expected != null && !ClearForInput(target))) return;
            foreach (var input in inputs) {
                if (input.SettleMs != 0 && (cancelled.WaitOne(input.SettleMs) || !target.Matches(false))) break;
                if (input.MoveWhileHeld) {
                    Rect raw;
                    if (!action.geometry.Matches(Locate(target, out raw))) break;
                }
                if (expected != null && !SameFocus(expected, ContentFocus(target, action.type == "text"))) break;
                if (sent > 0 && input.Pointer.HasValue && !input.Releases && !input.MoveWhileHeld &&
                    ClickTarget(input.Pointer.Value) != input.handle) break;
                lock (dispatch) {
                    if (!Allowed() || !StillFocused(expected)) break;
                    if (input.Pointer.HasValue && !target.Owns(WindowFromPoint(input.Pointer.Value))) break;
                    bool pressesPointer = input.Native.HasValue && input.Up != null && input.Up.ReleaseKey <= 2;
                    if (pressesPointer) pointerHeld = true;
                    bool queued = Queue(input);
                    // An unacknowledged native down may still have reached the OS input queue.
                    if (input.Up != null && (queued || input.Unconfirmed)) held.Add(input.Up);
                    if (!queued) {
                        if (pressesPointer && !input.Unconfirmed) pointerHeld = false;
                        unconfirmed = input.Unconfirmed;
                        break;
                    }
                    if (input.Releases) held.Remove(input);
                    sent++;
                }
                bool testHeld = action.type == "drag" ? input.SettleMs != 0 : input.Up != null && input.Up.ReleaseKey <= 2;
                if (action.holdRelease && testHeld) {
                    Write(new { @event = "test-held", upQueued = false });
                    cancelled.WaitOne(2500);
                    break;
                }
            }
            bool hoverCancelled = action.type == "hover" && sent == inputs.Count && cancelled.WaitOne(500);
            state = sent == inputs.Count && !action.holdRelease && !hoverCancelled ? "sent" : sent == 0 && !unconfirmed ? "refused" : "unknown";
        } catch {
            state = sent == 0 && !unconfirmed ? "refused" : "unknown";
        } finally {
            if (action.type == "drag" && (state != "sent" || Reason != null || stopping || !AtTarget())) {
                if (state == "sent") state = "unknown";
                try { CancelDrag(); } catch { /* Native release still has to run. */ }
            }
            released = ReleaseHeld();
            if (action.type == "drag" && state == "sent" && (Reason != null || stopping || !AtTarget())) state = "unknown";
            if (!released) {
                releaseUnverified = true;
                Revoke("release_unverified");
            }
            Interlocked.Exchange(ref inFlight, 0);
            Write(new { id = action.id, state = state, released = released });
        }
    }
    void Read() {
        try {
            string line;
            var reader = new JavaScriptSerializer();
            while ((line = Console.ReadLine()) != null) {
                if (line.Length > 12000) break;
                var action = reader.Deserialize<Command>(line);
                if (action == null || action.type == "release") break;
                if (action.type == "activate") { starting.Set(); continue; }
                if (!ready || Reason != null || stopping || Interlocked.CompareExchange(ref inFlight, 1, 0) != 0)
                    Write(new { id = action.id, state = "refused", released = !releaseUnverified });
                else {
                    action.holdRelease = testFault == "hold-release";
                    ThreadPool.QueueUserWorkItem(delegate { Perform(action); });
                }
            }
        } catch { }
        finally {
            lock (dispatch) { stopping = true; }
            cancelled.Set();
        }
    }
    void Enter() {
        var reader = new Thread(Read) { IsBackground = true };
        reader.Start();
        Write(new { @event = "prepared" });
        if (WaitHandle.WaitAny(new WaitHandle[] { cancelled, starting }, 2500) != 1 || stopping ||
            !DefaultDesktop() || !target.Matches(true) || !ClearForInput(target)) { Write(new { @event = "unavailable" }); return; }
        try {
            if (!RefreshInputHooks(true)) { Write(new { @event = "unavailable" }); return; }
            focusWatch = SetWinEventHook(3, 3, IntPtr.Zero, foregroundHook, 0, 0, 0);
            if (focusWatch == IntPtr.Zero) { Write(new { @event = "unavailable" }); return; }
            using (pump = new Control()) {
                var ownedPump = pump.Handle;
                if (!AtTarget()) {
                    lock (dispatch) {
                        if (stopping || Reason != null) return;
                        if (IsIconic(target.Window)) ShowWindowAsync(target.Window, 9);
                        SetForegroundWindow(target.Window);
                    }
                    for (int i = 0; i < 8 && !AtTarget() && !stopping; i++) Thread.Sleep(35);
                }
                if (stopping || !AtTarget() || !target.Matches(false)) { Write(new { @event = "unavailable" }); return; }
                // Exercise actual expired hook handles in the fixture without ever injecting input.
                if (testFault == "lost-keyboard") UnhookWindowsHookEx(keyboard);
                int checkingSurface = 0;
                using (var watch = new System.Threading.Timer(delegate {
                    if (stopping || Reason != null || Interlocked.CompareExchange(ref checkingSurface, 1, 0) != 0) return;
                    try {
                        if (!DefaultDesktop()) Revoke("desktop_unavailable");
                        else if (!target.Matches(false)) Revoke("window_changed");
                    } catch { Revoke("driver_lost"); }
                    finally { Interlocked.Exchange(ref checkingSurface, 0); }
                }, null, 100, 100))
                using (var timer = new System.Windows.Forms.Timer { Interval = 50 }) {
                    timer.Tick += delegate {
                        if (Reason == null && !stopping && !AtTarget()) Revoke("focus_lost");
                        if (Reason != null && !revocationReported) {
                            revocationReported = true;
                            Write(new { @event = "revoked", reason = Reason });
                        }
                        if ((stopping || Reason != null) && Interlocked.CompareExchange(ref inFlight, 0, 0) == 0) {
                            Write(new { @event = "released", released = ReleaseHeld() && !releaseUnverified });
                            timer.Stop();
                            Application.ExitThread();
                        }
                    };
                    ready = true;
                    Write(new { @event = "ready" });
                    timer.Start();
                    Application.Run();
                }
            }
        } finally {
            if (keyboard != IntPtr.Zero) UnhookWindowsHookEx(keyboard);
            if (pointer != IntPtr.Zero) UnhookWindowsHookEx(pointer);
            if (focusWatch != IntPtr.Zero) UnhookWinEvent(focusWatch);
        }
    }
    public static void Run(string command, string identity, string testFault, string cropJson) {
        var target = new JavaScriptSerializer().Deserialize<Target>(identity);
        if (target == null || target.hwnd <= 0 || target.session != Process.GetCurrentProcess().SessionId ||
            SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero) return;
        var session = new VykorWindowsForeground(target, testFault);
        if (command == "enter") session.Enter();
        else if (command == "capture") {
            var detail = String.IsNullOrEmpty(cropJson) ? null : new JavaScriptSerializer().Deserialize<Crop>(cropJson);
            var frame = Capture(target, detail);
            if (frame != null) session.Write(new { @event = "frame", frame = frame });
        }
    }
}
`

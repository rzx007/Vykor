using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class ProbeWindows
{
    private const uint Owner = 4;
    private delegate bool Visit(IntPtr window, IntPtr data);

    [DllImport("user32.dll")] private static extern bool EnumWindows(Visit visit, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint relation);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();

    [STAThread]
    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "foreground")
        {
            Console.WriteLine(GetForegroundWindow().ToInt64());
            return 0;
        }
        if (args.Length == 2 && args[0] == "process")
        {
            var sessionId = Process.GetCurrentProcess().SessionId;
            foreach (var process in Process.GetProcessesByName(args[1]))
                using (process)
                    if (process.SessionId == sessionId) Console.WriteLine(process.Id);
            return 0;
        }
        if (args.Length == 2 && args[0] == "folder")
        {
            ListExplorerFolder(args[1]);
            return 0;
        }
        if (args.Length != 5 || args[0] != "windows") return 2;

        var session = Process.GetCurrentProcess().SessionId;
        var image = args[1];
        var pidFilter = uint.Parse(args[2], CultureInfo.InvariantCulture);
        var ownerFilter = long.Parse(args[3], CultureInfo.InvariantCulture);
        var titlePrefix = args[4];

        EnumWindows(delegate(IntPtr window, IntPtr ignored) {
            if (!IsWindowVisible(window)) return true;
            uint pid;
            GetWindowThreadProcessId(window, out pid);
            if (pid == 0 || (pidFilter != 0 && pidFilter != pid)) return true;
            var owner = GetWindow(window, Owner).ToInt64();
            if (ownerFilter != 0 && ownerFilter != owner) return true;
            try
            {
                using (var process = Process.GetProcessById((int)pid))
                {
                    if (process.SessionId != session ||
                        !string.Equals(process.ProcessName, image, StringComparison.OrdinalIgnoreCase))
                        return true;
                }
            }
            catch (ArgumentException) { return true; }
            catch (InvalidOperationException) { return true; }

            if (titlePrefix.Length != 0)
            {
                var title = new StringBuilder(512);
                if (GetWindowText(window, title, title.Capacity) == 0 ||
                    !title.ToString().StartsWith(titlePrefix, StringComparison.OrdinalIgnoreCase))
                    return true;
            }

            Console.WriteLine("{0}\t{1}\t{2}", pid, window.ToInt64(), owner);
            return true;
        }, IntPtr.Zero);
        return 0;
    }

    // Emit only Explorer handles whose registered Shell window reports the exact fixture path.
    private static void ListExplorerFolder(string path)
    {
        var expected = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar);
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application", true));
        try
        {
            foreach (var window in shell.Windows())
            {
                try
                {
                    Uri uri;
                    if (Uri.TryCreate((string)window.LocationURL, UriKind.Absolute, out uri) && uri.IsFile &&
                        string.Equals(Path.GetFullPath(uri.LocalPath).TrimEnd(Path.DirectorySeparatorChar),
                            expected, StringComparison.OrdinalIgnoreCase))
                        Console.WriteLine(Convert.ToInt64(window.HWND, CultureInfo.InvariantCulture));
                }
                catch (COMException) { }
            }
        }
        finally { Marshal.FinalReleaseComObject(shell); }
    }
}

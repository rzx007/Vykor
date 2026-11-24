import { windowsAuthenticationQuery } from "./windows-authentication-query"

// Windows UI Automation supplies control identities and actions scoped to an exact window.
// The helper calls the target's accessibility pattern without using pointer or keyboard input.
export const windowsSemanticQuery = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows;
using System.Windows.Automation;

${windowsAuthenticationQuery}

public static class VykorWindowsSemanticQuery
{
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint relation);
    [DllImport("user32.dll")] private static extern IntPtr GetLastActivePopup(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetUserObjectInformation(IntPtr desktop, int index, StringBuilder name, uint size, out uint needed);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder title, int capacity);

    public sealed class Frame { public double x, y, w, h; }
    public sealed class Row
    {
        public int index, depth;
        public int? parentIndex;
        public string identity, role, label, automationId, value, valueDigest;
        public bool enabled, valueTruncated;
        public bool? selected, checkedState, expanded;
        public double? horizontalScrollPercent, verticalScrollPercent;
        public Frame frame;
        public List<string> actions = new List<string>();
    }

    private sealed class Control { public AutomationElement element; public Row row; }

    private static bool DefaultDesktop()
    {
        var desktop = OpenInputDesktop(0, false, 1);
        if (desktop == IntPtr.Zero) return false;
        try {
            var name = new StringBuilder(128);
            uint needed;
            return GetUserObjectInformation(desktop, 2, name, 256, out needed) &&
                String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
        } finally { CloseDesktop(desktop); }
    }

    private static bool ProcessMatches(int pid, string started, int session)
    {
        using (var process = Process.GetProcessById(pid)) {
            return process.SessionId == session && process.StartTime.ToFileTimeUtc().ToString(CultureInfo.InvariantCulture) == started;
        }
    }

    private static bool WindowMatches(long hwnd, long owner, int pid, uint thread, int session, string started, int app, string appStarted)
    {
        var window = new IntPtr(hwnd);
        var parent = new IntPtr(owner);
        if (!DefaultDesktop() || !IsWindowVisible(window) || !IsWindowEnabled(window) || GetWindow(window, 4) != parent ||
            (owner != 0 && (!IsWindowVisible(parent) || IsWindowEnabled(parent) || GetLastActivePopup(parent) != window))) return false;
        uint process;
        uint currentThread = GetWindowThreadProcessId(window, out process);
        if (currentThread == 0 || process != pid || (thread != 0 && thread != currentThread)) return false;
        using (var self = Process.GetCurrentProcess()) {
            return self.SessionId == session && ProcessMatches(pid, started, session)
                && (pid == app || ProcessMatches(app, appStarted, session));
        }
    }

    private static string Title(long hwnd)
    {
        var title = new StringBuilder(512);
        return GetWindowText(new IntPtr(hwnd), title, title.Capacity) == 0 ? null : title.ToString();
    }

    private static T Pattern<T>(AutomationElement element, AutomationPattern pattern) where T : class
    {
        object value;
        return element.TryGetCurrentPattern(pattern, out value) ? value as T : null;
    }

    private static string FirstText(params string[] parts)
    {
        foreach (var part in parts) if (!String.IsNullOrEmpty(part)) return part;
        return "";
    }

    private static string ValueDigest(string text)
    {
        using (var sha = SHA256.Create()) {
            return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "").ToLowerInvariant();
        }
    }

    private static Row Read(AutomationElement element, int index, int depth, int? parent)
    {
        var current = element.Current;
        if (VykorWindowsAuthentication.RequiresHandoff(current)) return null;
        int[] id = element.GetRuntimeId();
        if (id == null || id.Length == 0) return null;
        var controlType = current.ControlType;
        if (controlType == null) return null;
        Rect bounds = current.BoundingRectangle;
        var role = controlType.ProgrammaticName;
        var name = current.Name;
        var value = Pattern<ValuePattern>(element, ValuePattern.Pattern);
        var currentValue = value == null ? null : value.Current.Value;
        var automationId = current.AutomationId ?? String.Empty;
        var label = FirstText(name, automationId, current.HelpText);
        if (label.Length > 500) label = label.Substring(0, 500);
        var row = new Row {
            index = index, parentIndex = parent, depth = depth, identity = String.Join(",", id),
            role = role.StartsWith("ControlType.", StringComparison.Ordinal) ? role.Substring(12) : role,
            label = label, automationId = automationId.Length <= 128 ? automationId : String.Empty,
            enabled = current.IsEnabled, valueTruncated = currentValue != null && currentValue.Length > 6000,
            value = currentValue == null || currentValue.Length <= 6000 ? currentValue : currentValue.Substring(0, 6000),
            valueDigest = currentValue == null ? null : ValueDigest(currentValue),
            frame = bounds.IsEmpty ? null : new Frame { x = bounds.X, y = bounds.Y, w = bounds.Width, h = bounds.Height }
        };
        if (currentValue != null && !value.Current.IsReadOnly) row.actions.Add("set_value");
        if (Pattern<InvokePattern>(element, InvokePattern.Pattern) != null) row.actions.Add("invoke");
        var selection = Pattern<SelectionItemPattern>(element, SelectionItemPattern.Pattern);
        if (selection != null) {
            row.selected = selection.Current.IsSelected;
            row.actions.Add("select");
        }
        var toggle = Pattern<TogglePattern>(element, TogglePattern.Pattern);
        if (toggle != null) {
            var state = toggle.Current.ToggleState;
            if (state != ToggleState.Indeterminate) row.checkedState = state == ToggleState.On;
            row.actions.Add("toggle");
        }
        var expansion = Pattern<ExpandCollapsePattern>(element, ExpandCollapsePattern.Pattern);
        if (expansion != null && expansion.Current.ExpandCollapseState != ExpandCollapseState.LeafNode) {
            row.expanded = expansion.Current.ExpandCollapseState == ExpandCollapseState.Expanded;
            if (row.expanded == false) row.actions.Add("expand");
        }
        var scroll = Pattern<ScrollPattern>(element, ScrollPattern.Pattern);
        if (scroll != null) {
            if (scroll.Current.HorizontallyScrollable) row.horizontalScrollPercent = scroll.Current.HorizontalScrollPercent;
            if (scroll.Current.VerticallyScrollable) row.verticalScrollPercent = scroll.Current.VerticalScrollPercent;
            if (row.horizontalScrollPercent.HasValue || row.verticalScrollPercent.HasValue) row.actions.Add("scroll");
        }
        return row;
    }

    private static void Walk(AutomationElement element, int pid, int app, int depth, int? parent,
        List<Control> controls, ref int seen, ref string focusIdentity)
    {
        if (depth > 16 || ++seen > 240) return;
        int? nextParent = parent;
        if (element.Current.ProcessId == pid || element.Current.ProcessId == app) {
            var row = Read(element, controls.Count, depth, parent);
            if (row != null) {
                controls.Add(new Control { element = element, row = row });
                nextParent = row.index;
                if (element.Current.HasKeyboardFocus) focusIdentity = row.identity;
            }
        }
        if (depth == 16) return;
        var walker = TreeWalker.RawViewWalker;
        for (var child = walker.GetFirstChild(element); child != null && seen < 240; child = walker.GetNextSibling(child))
            Walk(child, pid, app, depth + 1, nextParent, controls, ref seen, ref focusIdentity);
    }

    public static object Run(long hwnd, long owner, int pid, uint thread, int session, string started, int app, string appStarted,
        string operation, string identity, string role, string label, string automationId, string direction, int amount, string oldValueDigest, string text, string title)
    {
        bool dispatched = false;
        try {
            if (!WindowMatches(hwnd, owner, pid, thread, session, started, app, appStarted)) return "refused";
            var currentTitle = Title(hwnd);
            if (VykorWindowsAuthentication.SensitiveCaption(currentTitle)) return "handoff";
            if (currentTitle == null || currentTitle != title) return "refused";
            var controls = new List<Control>();
            var root = AutomationElement.FromHandle(new IntPtr(hwnd));
            if (root == null || root.Current.NativeWindowHandle != hwnd) return "refused";
            int budget = 1000;
            if (!VykorWindowsAuthentication.Clear(root, ref budget, 0)) return "handoff";
            Func<bool> atTarget = () => Title(hwnd) == currentTitle && WindowMatches(hwnd, owner, pid, thread, session, started, app, appStarted);
            if (!atTarget()) return "refused";
            int seen = 0;
            string focusIdentity = null;
            Walk(root, pid, app, 0, null, controls, ref seen, ref focusIdentity);
            budget = 1000;
            if (!VykorWindowsAuthentication.Clear(root, ref budget, 0)) return "handoff";
            if (!atTarget()) return "refused";
            if (operation == "observe") {
                var focused = focusIdentity == null ? null : AutomationElement.FocusedElement;
                var focusedId = focused == null ? null : focused.GetRuntimeId();
                return new { rows = controls.ConvertAll(control => control.row),
                    focusIdentity = focusedId != null && String.Join(",", focusedId) == focusIdentity ? focusIdentity : null };
            }
            var matches = controls.FindAll(control => control.row.identity == identity);
            if (matches.Count != 1) return "refused";
            var element = matches[0].element;
            if (VykorWindowsAuthentication.RequiresHandoff(element.Current)) return "handoff";
            var row = Read(element, 0, 0, null);
            if (row == null || row.identity != identity || row.role != role || row.label != label ||
                row.automationId != automationId || !row.enabled) return "refused";
            if (operation == "set_text" && row.actions.Contains("set_value")) {
                var value = Pattern<ValuePattern>(element, ValuePattern.Pattern);
                if (value == null || value.Current.IsReadOnly || String.IsNullOrEmpty(oldValueDigest)) return "refused";
                var oldValue = value.Current.Value;
                if (oldValue == null || ValueDigest(oldValue) != oldValueDigest || !atTarget()) return "refused";
                dispatched = true;
                value.SetValue(text);
            } else if (operation == "invoke" && row.actions.Contains("invoke")) {
                var invoke = Pattern<InvokePattern>(element, InvokePattern.Pattern);
                if (invoke == null || !atTarget()) return "refused";
                dispatched = true;
                invoke.Invoke();
            } else if (operation == "invoke" && row.actions.Contains("expand")) {
                var expand = Pattern<ExpandCollapsePattern>(element, ExpandCollapsePattern.Pattern);
                if (expand == null || !atTarget()) return "refused";
                dispatched = true;
                expand.Expand();
            } else if (operation == "choose" && row.actions.Contains("select")) {
                if (row.selected == true) return "sent";
                var selection = Pattern<SelectionItemPattern>(element, SelectionItemPattern.Pattern);
                if (selection == null || !atTarget()) return "refused";
                dispatched = true;
                selection.Select();
            } else if (operation == "choose" && row.actions.Contains("toggle")) {
                if (row.checkedState == true) return "sent";
                if (row.checkedState != false) return "refused";
                var toggle = Pattern<TogglePattern>(element, TogglePattern.Pattern);
                if (toggle == null || !atTarget()) return "refused";
                dispatched = true;
                toggle.Toggle();
            } else if (operation == "scroll" && row.actions.Contains("scroll")) {
                var scroll = Pattern<ScrollPattern>(element, ScrollPattern.Pattern);
                bool horizontal = direction == "left" || direction == "right";
                if (amount < 1 || amount > 5 || (!horizontal && direction != "up" && direction != "down")) return "refused";
                if (scroll == null || (horizontal ? !row.horizontalScrollPercent.HasValue : !row.verticalScrollPercent.HasValue)) return "refused";
                ScrollAmount step = direction == "left" || direction == "up" ? ScrollAmount.SmallDecrement : ScrollAmount.SmallIncrement;
                for (int i = 0; i < amount; i++) {
                    if (!atTarget())
                        return dispatched ? "unknown" : "refused";
                    dispatched = true;
                    scroll.Scroll(horizontal ? step : ScrollAmount.NoAmount, horizontal ? ScrollAmount.NoAmount : step);
                }
            } else return "refused";
            return "sent";
        } catch (Exception) { return dispatched ? "unknown" : "refused"; }
    }
}
`

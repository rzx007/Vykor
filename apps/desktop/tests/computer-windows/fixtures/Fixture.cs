using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Fixture
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);

    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static string eventPath;

    private static void Log(object value)
    {
        File.AppendAllText(eventPath, Json.Serialize(value) + Environment.NewLine, new UTF8Encoding(false));
    }

    private sealed class ProbeWindow : Form
    {
        private readonly string id;
        private readonly Button increment;
        private readonly TextBox field;
        private readonly Label state;
        private int clicks;
        private int edits;

        internal ProbeWindow(string title, string id, Point location)
        {
            this.id = id;
            Text = title;
            StartPosition = FormStartPosition.Manual;
            Location = location;
            ClientSize = new Size(310, 142);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            KeyPreview = true;

            increment = new Button {
                Text = "Increment once", AccessibleName = "Increment once",
                Location = new Point(13, 12), Size = new Size(132, 28)
            };
            var slow = new Button {
                Text = "Delayed action", AccessibleName = "Delayed action",
                Location = new Point(152, 12), Size = new Size(126, 28)
            };
            field = new TextBox {
                AccessibleName = "Probe input", Location = new Point(13, 49), Size = new Size(265, 24)
            };
            state = new Label { Location = new Point(13, 84), AutoSize = true };
            Controls.AddRange(new Control[] { increment, slow, field, state });

            increment.Click += delegate { clicks++; UpdateState("click"); };
            slow.Click += delegate {
                Record("slow-begin");
                System.Threading.Thread.Sleep(2000);
                Record("slow-done");
            };
            field.TextChanged += delegate { edits++; UpdateState("edit"); };
            Activated += delegate { Record("activate"); };
            Deactivate += delegate { Record("deactivate"); };
            KeyDown += (_, evt) => Record("key-down-" + evt.KeyCode);
            KeyUp += (_, evt) => Record("key-up-" + evt.KeyCode);

            foreach (var control in new Control[] { this, increment, slow, field, state })
            {
                control.MouseDown += (_, evt) => Record("mouse-down-" + evt.Button);
                control.MouseUp += (_, evt) => Record("mouse-up-" + evt.Button);
            }

            UpdateState(null);
        }

        private void UpdateState(string change)
        {
            state.Text = "clicks=" + clicks + " edits=" + edits + " value=" + field.Text;
            state.AccessibleName = state.Text;
            if (change != null) Record(change);
        }

        internal void Record(string change)
        {
            Log(new {
                kind = change, window = id, clicks, edits, value = field.Text,
                hwnd = Handle.ToInt64(), foreground = GetForegroundWindow().ToInt64(),
                utc = DateTime.UtcNow.ToString("o")
            });
        }

        internal void ReplaceWindow()
        {
            RecreateHandle();
            Record("recreated");
        }

        internal void FocusControl(bool editor)
        {
            Control destination = editor ? (Control)field : increment;
            if (destination.Focus()) Record(editor ? "focus-editor" : "focus-button");
        }

        internal void ShowAuthenticationField()
        {
            field.AccessibleName = "Verification code";
            Record("authentication");
        }

        protected override bool ProcessDialogKey(Keys keyData)
        {
            if ((keyData & Keys.KeyCode) == Keys.Tab) Record("key-down-Tab");
            return base.ProcessDialogKey(keyData);
        }
    }

    [STAThread]
    internal static void Main(string[] args)
    {
        bool registeredLaunch = args.Length == 0;
        if (!registeredLaunch && args.Length != 2) return;

        eventPath = registeredLaunch ? Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fixture.jsonl") : args[0];
        string directory = Path.GetDirectoryName(eventPath);
        string title = registeredLaunch ? "Meeting notes.txt - Vykor Stage 3 probe" : "Vykor Cua probe " + args[1];
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        Rectangle area = Screen.PrimaryScreen.WorkingArea;
        var target = new ProbeWindow(title, "target", new Point(area.X + 25, area.Y + 75));
        var control = new ProbeWindow(title, "control", new Point(area.X + 375, area.Y + 75));
        var lifetime = Stopwatch.StartNew();
        var timer = new Timer { Interval = 50 };
        bool recreated = false;
        bool renamed = false;
        Form dialog = null;
        timer.Tick += delegate {
            if (File.Exists(Path.Combine(directory, "close.request")) || lifetime.Elapsed.TotalSeconds >= 150)
            {
                if (dialog != null && !dialog.IsDisposed) dialog.Close();
                target.Close();
                return;
            }
            var focusPath = Path.Combine(directory, "focus.request");
            if (File.Exists(focusPath)) {
                string name = File.ReadAllText(focusPath);
                File.Delete(focusPath);
                if (name == "target") target.Activate();
                if (name == "control") control.Activate();
                if (name == "target-editor") target.FocusControl(true);
                if (name == "target-button") target.FocusControl(false);
            }
            var authPath = Path.Combine(directory, "auth.request");
            if (File.Exists(authPath)) {
                File.Delete(authPath);
                target.ShowAuthenticationField();
            }
            var externalPath = Path.Combine(directory, "external.request");
            if (File.Exists(externalPath)) {
                string name = File.ReadAllText(externalPath);
                File.Delete(externalPath);
                var exact = name == "target" ? target : name == "control" || name == "control-esc" ? control : null;
                if (exact != null && GetForegroundWindow() == exact.Handle) {
                    byte key = name == "control-esc" ? (byte)0x1B : (byte)0x78;
                    keybd_event(key, 0, 0, UIntPtr.Zero);
                    keybd_event(key, 0, 2, UIntPtr.Zero);
                }
            }
            if (!recreated && File.Exists(Path.Combine(directory, "recreate.request")))
            {
                recreated = true;
                target.ReplaceWindow();
            }
            var uniquePath = Path.Combine(directory, "unique.request");
            if (registeredLaunch && !renamed && File.Exists(uniquePath))
            {
                long selectedWindow;
                if (long.TryParse(File.ReadAllText(uniquePath), out selectedWindow))
                {
                    var other = selectedWindow == target.Handle.ToInt64() ? control : target;
                    other.Text = "Other notes.txt - Vykor Stage 3 probe";
                    renamed = true;
                    Log(new { kind = "unique" });
                }
            }
            var modalPath = Path.Combine(directory, "modal.request");
            if (registeredLaunch && dialog == null && File.Exists(modalPath))
            {
                long selectedWindow;
                if (!long.TryParse(File.ReadAllText(modalPath), out selectedWindow)) return;
                var parent = selectedWindow == control.Handle.ToInt64() ? control : target;
                dialog = new Form {
                    Text = "Vykor Stage 3 owned dialog",
                    FormBorderStyle = FormBorderStyle.FixedDialog,
                    StartPosition = FormStartPosition.CenterParent,
                    ShowInTaskbar = false,
                    ClientSize = new Size(280, 105)
                };
                dialog.Shown += delegate {
                    Log(new {
                        kind = "modal", hwnd = dialog.Handle.ToInt64(), owner = parent.Handle.ToInt64(), title = dialog.Text
                    });
                };
                dialog.ShowDialog(parent);
                dialog.Dispose();
            }
        };
        target.FormClosed += delegate {
            timer.Stop();
            control.Close();
            if (registeredLaunch) Log(new { kind = "closed" });
            Application.ExitThread();
        };
        target.Shown += delegate {
            control.Show();
            control.Activate();
            target.BeginInvoke((Action)delegate {
                var buttonPoint = target.PointToScreen(new Point(40, 25));
                Log(new {
                    kind = "ready", pid = Process.GetCurrentProcess().Id,
                    target = target.Handle.ToInt64(), control = control.Handle.ToInt64(),
                    targetTitle = target.Text, controlTitle = control.Text,
                    interactive = Environment.UserInteractive,
                    sessionId = Process.GetCurrentProcess().SessionId,
                    foreground = GetForegroundWindow().ToInt64(),
                    buttonX = buttonPoint.X, buttonY = buttonPoint.Y
                });
                timer.Start();
            });
        };
        Application.Run(target);
    }
}

// MAVLink Hub for Windows: the app itself ("MAVLink Hub.exe").
//
// It is the program you see in the taskbar, so it can be pinned, and it has its own icon. It:
//   1. opens its window at once, with a spinner while the hub starts;
//   2. starts the hub (runtime\node.exe launcher.js, no console window) and waits for it to say which port it is on;
//   3. shows the hub's control page in a WebView2 control (the Edge engine that comes with Windows 10 and 11);
//   4. stops the hub when the window is closed. The hub also stops by itself if this program disappears (HUB_EXIT_WITH).
// If WebView2 is not available it falls back to the hub's own browser app window (launcher.js does that).
//
// Built with the C# compiler that ships with Windows (csc.exe, C# 5), so keep to C# 5 syntax. See tools/build-packages.js.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace MavlinkHub
{
    static class Program
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool SetDllDirectory(string path);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr FindWindow(string cls, string title);
        [DllImport("user32.dll")]
        static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr h, int cmd);

        static Mutex single;

        [STAThread]
        static void Main()
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            bool first;
            single = new Mutex(true, "Local\\MAVLinkHub.App", out first);
            if (!first)   // already open: bring that window forward instead of starting a second hub
            {
                IntPtr h = FindWindow(null, "MAVLink Hub");
                if (h != IntPtr.Zero) { ShowWindow(h, 9); SetForegroundWindow(h); }
                return;
            }
            // WebView2's files live in runtime\webview2 (the managed ones and WebView2Loader.dll).
            string wv = Path.Combine(dir, "runtime", "webview2");
            SetDllDirectory(wv);
            AppDomain.CurrentDomain.AssemblyResolve += delegate(object s, ResolveEventArgs e)
            {
                string file = Path.Combine(wv, new AssemblyName(e.Name).Name + ".dll");
                return File.Exists(file) ? Assembly.LoadFrom(file) : null;
            };
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new HubForm(dir));
        }
    }

    // A turning ring of dots.
    class Spinner : Control
    {
        int step;
        System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();

        public Spinner()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            timer.Interval = 60;
            timer.Tick += delegate { step = (step + 1) % 12; Invalidate(); };
            timer.Start();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float cx = Width / 2f, cy = Height / 2f, r = Math.Min(Width, Height) / 2f - 7f;
            for (int i = 0; i < 12; i++)
            {
                int age = (step - i + 12) % 12;
                int alpha = Math.Max(30, 255 - age * 20);
                double a = i * Math.PI / 6;
                float x = cx + (float)Math.Sin(a) * r, y = cy - (float)Math.Cos(a) * r;
                using (SolidBrush b = new SolidBrush(Color.FromArgb(alpha, 47, 128, 237))) g.FillEllipse(b, x - 5f, y - 5f, 10f, 10f);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) timer.Dispose();
            base.Dispose(disposing);
        }
    }

    // The WebView2 part lives apart so its assembly is only loaded once the resolver in Main is in place.
    static class WebHost
    {
        [MethodImpl(MethodImplOptions.NoInlining)]
        public static Control Create(string profileDir, string url, int port, Action loaded, Action<string> failed)
        {
            Microsoft.Web.WebView2.WinForms.WebView2 wv = new Microsoft.Web.WebView2.WinForms.WebView2();
            wv.Dock = DockStyle.Fill;
            Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties props = new Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties();
            props.UserDataFolder = profileDir;
            wv.CreationProperties = props;
            wv.CoreWebView2InitializationCompleted += delegate(object s, Microsoft.Web.WebView2.Core.CoreWebView2InitializationCompletedEventArgs e)
            {
                if (!e.IsSuccess) { failed(e.InitializationException != null ? e.InitializationException.Message : "WebView2 could not start"); return; }
                Microsoft.Web.WebView2.Core.CoreWebView2 core = wv.CoreWebView2;
                core.Settings.AreDevToolsEnabled = false;
                core.NewWindowRequested += delegate(object a, Microsoft.Web.WebView2.Core.CoreWebView2NewWindowRequestedEventArgs b)
                {
                    b.Handled = true; Open(b.Uri);
                };
                core.NavigationStarting += delegate(object a, Microsoft.Web.WebView2.Core.CoreWebView2NavigationStartingEventArgs b)
                {   // only the control page lives in this window; everything else opens in the browser
                    Uri u;
                    bool mine = Uri.TryCreate(b.Uri, UriKind.Absolute, out u) && (u.Host == "localhost" || u.Host == "127.0.0.1") && u.Port == port
                        && (u.AbsolutePath.StartsWith("/launcher") || u.AbsolutePath.StartsWith("/assets"));
                    if (!mine) { b.Cancel = true; Open(b.Uri); }
                };
                core.NavigationCompleted += delegate { loaded(); };
            };
            wv.Source = new Uri(url);
            return wv;
        }

        static void Open(string uri)
        {
            if (Regex.IsMatch(uri ?? "", "^https?://")) { try { Process.Start(uri); } catch (Exception) { } }
        }
    }

    class HubForm : Form
    {
        readonly string dir;
        readonly int ownPid = Process.GetCurrentProcess().Id;
        Panel loading;
        Label status;
        Control web;
        int port;
        volatile bool closing;
        bool handedOff;

        public HubForm(string dir)
        {
            this.dir = dir;
            Text = "MAVLink Hub";
            ClientSize = new Size(520, 840);
            MinimumSize = new Size(440, 600);
            StartPosition = FormStartPosition.CenterScreen;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { }

            loading = new Panel();
            loading.Dock = DockStyle.Fill;
            loading.BackColor = Color.FromArgb(242, 244, 248);
            Spinner spin = new Spinner();
            spin.Size = new Size(72, 72);
            status = new Label();
            status.Text = "Starting MAVLink Hub…";
            status.AutoSize = false;
            status.TextAlign = ContentAlignment.MiddleCenter;
            status.Font = new Font("Segoe UI", 11f);
            status.ForeColor = Color.FromArgb(85, 96, 112);
            status.Size = new Size(420, 28);
            loading.Controls.Add(spin);
            loading.Controls.Add(status);
            loading.Resize += delegate
            {
                spin.Location = new Point((loading.Width - spin.Width) / 2, loading.Height / 2 - spin.Height - 6);
                status.Location = new Point((loading.Width - status.Width) / 2, loading.Height / 2 + 14);
            };
            Controls.Add(loading);
            Shown += delegate { Begin(); };
            FormClosing += delegate { closing = true; if (!handedOff && port > 0) StopHub(port); };
        }

        // Start the hub on a background thread so the spinner keeps turning.
        void Begin()
        {
            Thread t = new Thread(delegate()
            {
                string error; int p = StartHub(true, out error);
                if (closing) { if (p > 0) StopHub(p); return; }
                try { BeginInvoke((MethodInvoker)delegate { Started(p, error); }); } catch (Exception) { }
            });
            t.IsBackground = true;
            t.Start();
        }

        void Started(int p, string error)
        {
            if (p <= 0)
            {
                MessageBox.Show(error, "MAVLink Hub", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                handedOff = true; Close(); return;
            }
            port = p;
            string profile = Path.Combine(Environment.GetEnvironmentVariable("APPDATA") ?? dir, "MAVLink Hub", "webview2-profile");
            Directory.CreateDirectory(profile);
            try
            {
                web = WebHost.Create(profile, "http://localhost:" + p + "/launcher",
                    p,
                    delegate { try { BeginInvoke((MethodInvoker)delegate { loading.Visible = false; }); } catch (Exception) { } },
                    delegate(string why) { try { BeginInvoke((MethodInvoker)delegate { Fallback(); }); } catch (Exception) { } });
                Controls.Add(web);
                loading.BringToFront();
            }
            catch (Exception) { Fallback(); }
        }

        // WebView2 is missing or broken: stop this hub and let the launcher open the hub in a browser app window instead.
        void Fallback()
        {
            if (handedOff) return;
            handedOff = true;
            StopHub(port);
            Thread.Sleep(1500);
            string error; StartHub(false, out error);
            Application.Exit();
        }

        string FindNode()
        {
            string bundled = Path.Combine(dir, "runtime", "node.exe");
            if (File.Exists(bundled)) return bundled;
            foreach (string d in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
            {
                try { string c = Path.Combine(d.Trim('"'), "node.exe"); if (File.Exists(c)) return c; } catch (Exception) { }
            }
            string pf = Environment.GetEnvironmentVariable("ProgramFiles"), la = Environment.GetEnvironmentVariable("LOCALAPPDATA");
            foreach (string c in new string[] { pf == null ? null : Path.Combine(pf, "nodejs", "node.exe"), la == null ? null : Path.Combine(la, "Programs", "nodejs", "node.exe") })
                if (c != null && File.Exists(c)) return c;
            return null;
        }

        // Runs launcher.js, which starts the hub (or finds it running) and prints HUB_PORT=n. With `ownWindow` false it also opens
        // the hub's browser app window. Returns the port, or 0 and a plain-English reason.
        int StartHub(bool ownWindow, out string error)
        {
            error = "The hub could not start.";
            string node = FindNode();
            if (node == null)
            {
                error = "Node.js was not found, and the hub needs it. This copy of MAVLink Hub may be incomplete; install it again.";
                return 0;
            }
            ProcessStartInfo psi = new ProcessStartInfo(node, "\"" + Path.Combine(dir, "launcher.js") + "\"");
            psi.WorkingDirectory = dir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            if (ownWindow)
            {
                psi.EnvironmentVariables["LAUNCHER_NO_WINDOW"] = "1";
                psi.EnvironmentVariables["HUB_OWNER_PID"] = ownPid.ToString();    // the updater closes this program when it installs an update
                psi.EnvironmentVariables["HUB_EXIT_WITH"] = ownPid.ToString();    // and the hub stops by itself if this program goes away
            }
            StringBuilder o = new StringBuilder(), er = new StringBuilder();
            try
            {
                using (Process p = Process.Start(psi))
                {
                    p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) o.AppendLine(e.Data); };
                    p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) er.AppendLine(e.Data); };
                    p.BeginOutputReadLine(); p.BeginErrorReadLine();
                    if (!p.WaitForExit(90000)) { error = "The hub is taking too long to start. Check the log in the saved-maps folder (hub.log)."; return 0; }
                    p.WaitForExit();
                }
            }
            catch (Exception ex) { error = "The hub could not be started: " + ex.Message; return 0; }
            Match m = Regex.Match(o.ToString(), @"HUB_PORT=(\d+)");   // this marker, not the exit code, says it worked
            if (m.Success) return int.Parse(m.Groups[1].Value);
            string text = er.ToString().Trim();
            if (text.Length > 0) error = text;
            return 0;
        }

        static void StopHub(int port)
        {
            try
            {
                HttpWebRequest rq = (HttpWebRequest)WebRequest.Create("http://localhost:" + port + "/launcher/stop");
                rq.Method = "POST";
                rq.Proxy = null;
                rq.Timeout = 2000;
                rq.ContentType = "application/json";
                rq.Headers["X-Launcher"] = "1";
                rq.Headers["Origin"] = "http://localhost:" + port;
                byte[] body = Encoding.ASCII.GetBytes("{}");
                rq.ContentLength = body.Length;
                using (Stream s = rq.GetRequestStream()) s.Write(body, 0, body.Length);
                rq.GetResponse().Close();
            }
            catch (Exception) { }
        }
    }
}

using System;
using System.Diagnostics;
using System.IO;
using System.Text;

// A GUI-subsystem bootstrap avoids the detached-console lifetime and startup
// problems of launching Windows PowerShell directly from Node/Electron.
internal static class PortableLauncher
{
    private static int Main(string[] args)
    {
        string folder = AppDomain.CurrentDomain.BaseDirectory;
        string logFile = Path.Combine(folder, "installer.log");
        try
        {
            if (args.Length != 2) return 2;
            string script = Path.GetFullPath(args[0]);
            string plan = Path.GetFullPath(args[1]);
            if (!String.Equals(script, Path.Combine(folder, "installer.ps1"), StringComparison.OrdinalIgnoreCase)
                || !String.Equals(plan, Path.Combine(folder, "plan.json"), StringComparison.OrdinalIgnoreCase)
                || script.Contains("\"") || plan.Contains("\"")) return 2;
            var info = new ProcessStartInfo();
            info.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            info.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\" -PlanFile \"" + plan + "\" -Mode Apply";
            info.WorkingDirectory = folder;
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            info.RedirectStandardInput = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            using (var log = new StreamWriter(logFile, true, new UTF8Encoding(false)))
            using (var process = new Process())
            {
                log.AutoFlush = true;
                object gate = new object();
                process.StartInfo = info;
                DataReceivedEventHandler write = (sender, data) => { if (data.Data != null) { lock (gate) { log.WriteLine(data.Data); } } };
                process.OutputDataReceived += write;
                process.ErrorDataReceived += write;
                if (!process.Start()) return 3;
                process.StandardInput.Close();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            try { File.AppendAllText(logFile, error.ToString()); } catch { }
            return 1;
        }
    }
}

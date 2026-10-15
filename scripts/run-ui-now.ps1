Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# The harness sets ELECTRON_RUN_AS_NODE=1, which makes the packaged Electron binary
# behave as plain Node and exit. Never inherit it into the launched app.
$source = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Diagnostics;

public class AppForegroundLauncher {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcess(
        string lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation
    );

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpfn, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    public static bool LaunchAndBringToFront(string exePath) {
        bool result = false;
        Thread t = new Thread(() => {
            IntPtr hDesk = OpenDesktop("Default", 0, false, 0x01FF);
            if (hDesk == IntPtr.Zero) {
                Console.WriteLine("Could not open Default desktop: " + Marshal.GetLastWin32Error());
                return;
            }
            if (!SetThreadDesktop(hDesk)) {
                Console.WriteLine("Could not set thread desktop: " + Marshal.GetLastWin32Error());
                return;
            }

            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(si);
            si.lpDesktop = @"WinSta0\Default";
            si.dwFlags = 1; // STARTF_USESHOWWINDOW
            si.wShowWindow = 1; // SW_SHOWNORMAL

            PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
            bool ok = CreateProcess(exePath, "\"" + exePath + "\"", IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi);
            if (!ok) {
                Console.WriteLine("CreateProcess failed: " + Marshal.GetLastWin32Error());
                return;
            }
            Console.WriteLine("Switchboard created on Default desktop! PID: " + pi.dwProcessId);

            // Wait a moment for the window to initialize and show
            for (int i = 0; i < 20; i++) {
                Thread.Sleep(300);
                IntPtr targetHwnd = IntPtr.Zero;
                string foundTitle = "";

                EnumWindows((hWnd, lParam) => {
                    uint pid;
                    GetWindowThreadProcessId(hWnd, out pid);
                    if (pid == pi.dwProcessId) {
                        StringBuilder sb = new StringBuilder(256);
                        GetWindowText(hWnd, sb, 256);
                        targetHwnd = hWnd;
                        foundTitle = sb.ToString();
                        return false;
                    }
                    return true;
                }, IntPtr.Zero);

                if (targetHwnd != IntPtr.Zero) {
                    Console.WriteLine("Found window hWnd: " + targetHwnd + " ('" + foundTitle + "')");
                    ShowWindow(targetHwnd, 9); // SW_RESTORE
                    ShowWindow(targetHwnd, 5); // SW_SHOW
                    SetForegroundWindow(targetHwnd);
                    BringWindowToTop(targetHwnd);
                    result = true;
                    return;
                }
            }
            result = true;
        });
        t.Start();
        t.Join();
        return result;
    }
}
"@

Stop-Process -Name "Switchboard", "electron" -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400

Add-Type -TypeDefinition $source
$exe = "C:\Users\sachi\AppData\Local\Programs\Switchboard\Switchboard.exe"
[AppForegroundLauncher]::LaunchAndBringToFront($exe)

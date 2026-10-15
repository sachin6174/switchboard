param (
    [string]$ExePath = "C:\Users\sachi\AppData\Local\Programs\Switchboard\Switchboard.exe"
)

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# The harness sets ELECTRON_RUN_AS_NODE=1, which makes the packaged Electron binary
# behave as plain Node and exit. Never inherit it into the launched app.
$source = @"
using System;
using System.Runtime.InteropServices;

public class DesktopLauncher {
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

    public static int LaunchOnDefaultDesktop(string exePath, string cmdLine) {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(si);
        si.lpDesktop = @"WinSta0\default";
        si.dwFlags = 1; // STARTF_USESHOWWINDOW
        si.wShowWindow = 1; // SW_SHOWNORMAL

        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        bool ok = CreateProcess(exePath, cmdLine, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref si, out pi);
        if (!ok) {
            int err = Marshal.GetLastWin32Error();
            throw new Exception("CreateProcess failed with error: " + err);
        }
        return pi.dwProcessId;
    }
}
"@

if (-not ([System.Management.Automation.PSTypeName]'DesktopLauncher').Type) {
    Add-Type -TypeDefinition $source
}

Stop-Process -Name "Switchboard" -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300

$pidLaunched = [DesktopLauncher]::LaunchOnDefaultDesktop($ExePath, "`"$ExePath`"")
Write-Output "Successfully launched PID: $pidLaunched on WinSta0\default"
Start-Sleep -Seconds 3
Get-Process -Id $pidLaunched | Select-Object Id, ProcessName, MainWindowTitle, MainWindowHandle

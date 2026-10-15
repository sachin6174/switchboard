param (
    [string]$ExePath = "C:\Users\sachi\AppData\Local\Programs\Switchboard\Switchboard.exe",
    [string]$LogFile = ""
)

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# The harness sets ELECTRON_RUN_AS_NODE=1, which makes the packaged Electron binary
# behave as plain Node and exit. Never inherit it into the launched app.

if (-not $LogFile) {
    $LogFile = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\artifacts\app-launch-live.log"
}
$LogFile = [System.IO.Path]::GetFullPath($LogFile)

$source = @"
using System;
using System.Runtime.InteropServices;

public class DesktopLauncher2 {
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

if (-not ([System.Management.Automation.PSTypeName]'DesktopLauncher2').Type) {
    Add-Type -TypeDefinition $source
}

Stop-Process -Name "Switchboard" -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300
Remove-Item $LogFile -ErrorAction SilentlyContinue

$cmdLine = '"' + $ExePath + '" --enable-logging --log-file="' + $LogFile + '"'
$pidLaunched = [DesktopLauncher2]::LaunchOnDefaultDesktop($ExePath, $cmdLine)
Write-Output "Launched PID: $pidLaunched"
Start-Sleep -Seconds 12
Write-Output "=== process state ==="
Get-Process Switchboard -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, MainWindowTitle, MainWindowHandle, Responding | Format-Table -AutoSize | Out-String -Width 200
Write-Output "=== log file ==="
if (Test-Path $LogFile) { Get-Content $LogFile -Tail 60 | Out-String -Width 250 } else { Write-Output "(no log file produced)" }

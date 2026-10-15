$ErrorActionPreference = "Stop"

$releaseDir = Join-Path $PSScriptRoot "..\release"
$installer = Get-ChildItem -Path (Join-Path $releaseDir "Switchboard Setup *.exe") | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) {
    throw "No installer found in $releaseDir"
}
$installerPath = $installer.FullName
$targetExe = "$env:LOCALAPPDATA\Programs\Switchboard\Switchboard.exe"

Write-Host "1. Verifying installer exists at: $installerPath"
if (-not (Test-Path $installerPath)) {
    throw "Installer file not found at $installerPath"
}
$installerItem = Get-Item $installerPath
Write-Host "   Installer size: $([math]::Round($installerItem.Length / 1MB, 2)) MB, Last modified: $($installerItem.LastWriteTime)"

Write-Host "2. Terminating any lingering Switchboard instances..."
Get-Process | Where-Object { $_.ProcessName -match "Switchboard" } | ForEach-Object {
    Write-Host "   Killing PID $($_.Id) ($($_.ProcessName))..."
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

Write-Host "3. Executing installer silently (/S)..."
$process = Start-Process -FilePath $installerPath -ArgumentList "/S" -PassThru -Wait
Write-Host "   Installer process exited with code: $($process.ExitCode)"

Start-Sleep -Seconds 3

Write-Host "4. Checking installation directory: $env:LOCALAPPDATA\Programs\Switchboard"
if (Test-Path $targetExe) {
    $info = Get-Item $targetExe
    Write-Host "   Installed EXE: $targetExe"
    Write-Host "   File Version: $($info.VersionInfo.FileVersion)"
    Write-Host "   Product Version: $($info.VersionInfo.ProductVersion)"
    Write-Host "   Last Written: $($info.LastWriteTime)"
} else {
    throw "Installed executable not found at $targetExe"
}

Write-Host "5. Checking shortcuts..."
$startLnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Switchboard.lnk"
$deskLnk = "$env:USERPROFILE\Desktop\Switchboard.lnk"
Write-Host "   Start Menu: $(Test-Path $startLnk)"
Write-Host "   Desktop:    $(Test-Path $deskLnk)"

Write-Host "6. Launching Switchboard via Windows Explorer..."
Start-Process -FilePath "explorer.exe" -ArgumentList "`"$targetExe`""
Start-Sleep -Seconds 3

Write-Host "7. Verifying launched process..."
$running = Get-Process -Name "Switchboard" -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "   Switchboard is running with $($running.Count) processes: $($running.Id -join ', ')"
} else {
    Write-Host "   Switchboard process not detected yet, attempting direct launch..."
    Start-Process -FilePath $targetExe
}

Write-Host "Installation completed successfully."

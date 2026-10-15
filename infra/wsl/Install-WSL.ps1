$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Start-Transcript -Path (Join-Path $root 'install-wsl.log') -Append
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator privileges required.' }
    & wsl.exe --install --no-distribution --web-download
    $installExit = $LASTEXITCODE
    $features = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
    [pscustomobject]@{Timestamp=(Get-Date -Format o);InstallExit=$installExit;VirtualMachinePlatform=[string]$features.State;RestartPending=(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')} | ConvertTo-Json | Set-Content (Join-Path $root 'install-status.json') -Encoding UTF8
} catch {
    [pscustomobject]@{Timestamp=(Get-Date -Format o);Error=$_.Exception.Message} | ConvertTo-Json | Set-Content (Join-Path $root 'install-status.json') -Encoding UTF8
    throw
} finally { Stop-Transcript }

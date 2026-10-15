$ErrorActionPreference = 'Stop'
$features = @('VirtualMachinePlatform','Microsoft-Windows-Subsystem-Linux') | ForEach-Object { Get-WindowsOptionalFeature -Online -FeatureName $_ | Select-Object FeatureName,State }
$processes = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('wsl.exe','msiexec.exe','dism.exe') } | Select-Object ProcessId,Name,CommandLine
[pscustomobject]@{Features=$features;Processes=$processes;RestartPending=(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $PSScriptRoot 'diagnostic-status.json') -Encoding UTF8

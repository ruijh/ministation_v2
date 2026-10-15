$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$msi = Join-Path $root 'wsl.3.0.3.0.x64.msi'
Start-Transcript -Path (Join-Path $root 'install-msi.log') -Append
try {
    $sig = Get-AuthenticodeSignature -LiteralPath $msi
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'Microsoft MSI signature verification failed.' }
    # Stop only our own download-only bootstrapper before invoking the MSI installer.
    Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'wsl.exe' -and $_.CommandLine -match '--install --no-distribution --web-download' } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction Stop }
    $installed = Start-Process msiexec.exe -WindowStyle Hidden -ArgumentList "/i `"$msi`" /qn /norestart /L*v `"$root\msi-detail.log`"" -Wait -PassThru
    if ($installed.ExitCode -notin @(0,3010)) { throw "WSL MSI failed with exit code $($installed.ExitCode)" }
    $feature = Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -All -NoRestart
    [pscustomobject]@{Timestamp=(Get-Date -Format o);MsiExit=$installed.ExitCode;FeatureRestartNeeded=$feature.RestartNeeded;RestartPending=(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')} | ConvertTo-Json | Set-Content (Join-Path $root 'msi-status.json') -Encoding UTF8
} catch {
    [pscustomobject]@{Timestamp=(Get-Date -Format o);Error=$_.Exception.Message} | ConvertTo-Json | Set-Content (Join-Path $root 'msi-status.json') -Encoding UTF8
    throw
} finally { Stop-Transcript }

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root
$credentialDir = Join-Path $root 'credentials'
New-Item -ItemType Directory -Force $credentialDir | Out-Null
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $credentialDir /inheritance:r /grant:r "${currentUser}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot secure credential directory.' }
Start-Transcript -Path (Join-Path $root 'cluster-install.log') -Append
try {
    $distro = 'MiniStation'
    $archive = Join-Path $root 'ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz'
    $expectedLine = Get-Content (Join-Path $root 'SHA256SUMS') | Where-Object { $_ -match 'ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz$' } | Select-Object -First 1
    if (-not $expectedLine) { throw 'Missing official Ubuntu checksum.' }
    $expectedHash = ($expectedLine -split '\s+')[0]
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Ubuntu SHA256 mismatch.' }
    $distros = ((& wsl.exe --list --quiet) -join "`n") -replace "`0", ''
    if ($distros -notmatch '(?m)^MiniStation\s*$') {
        & wsl.exe --import $distro (Join-Path $root 'distro') $archive --version 2
        if ($LASTEXITCODE -ne 0) { throw 'WSL import failed. If Windows requests a reboot, restart first and rerun this script.' }
    }
    $linuxRoot = (& wsl.exe -d $distro -u root --exec wslpath -a ($root.Replace('\','/'))).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'WSL failed to start.' }
    $currentWslConfig = (& wsl.exe -d $distro -u root --exec cat /etc/wsl.conf) -join "`n"
    if ($currentWslConfig.Trim() -ne "[boot]`nsystemd=true") {
        & wsl.exe -d $distro -u root --exec cp "$linuxRoot/wsl.conf" /etc/wsl.conf
        if ($LASTEXITCODE -ne 0) { throw 'WSL configuration failed.' }
        & wsl.exe --terminate $distro
    }
    & (Join-Path $root 'Keep-WSL-Running.ps1')
    & wsl.exe -d $distro -u root --exec bash "$linuxRoot/bootstrap-kubernetes.sh"
    if ($LASTEXITCODE -ne 0) { throw 'Cluster setup or validation failed. See cluster-install.log.' }
    $envText = @(
      '$env:MINISTATION_KUBE_URL = ''https://127.0.0.1:16443'''
      '$env:MINISTATION_KUBE_TOKEN_FILE = Join-Path $PSScriptRoot ''credentials/controller.token'''
      '$env:MINISTATION_KUBE_CA_FILE = Join-Path $PSScriptRoot ''credentials/ca.crt'''
    )
    $envText | Set-Content (Join-Path $root 'Use-Cluster.ps1') -Encoding UTF8
    Write-Host 'SUCCESS: MiniStation WSL2 and three-node Kubernetes cluster validated.'
} finally { Stop-Transcript }

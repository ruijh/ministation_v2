$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if (Test-Path '.\infra\wsl\Use-Cluster.ps1') { . '.\infra\wsl\Use-Cluster.ps1' }
$env:MINISTATION_UPSTREAM_HOSTS = 'api.minimaxi.com,127.0.0.1,localhost'
$env:NODE_USE_ENV_PROXY = '1'
New-Item -ItemType Directory -Force '.\data' | Out-Null
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe (Join-Path (Get-Location) 'data') /inheritance:r /grant:r "${currentUser}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot secure local data directory.' }
node server/index.mjs

$ErrorActionPreference = 'Stop'
$existing = Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" | Where-Object { $_.CommandLine -match '-d MiniStation -u root --exec sleep infinity' }
if (-not $existing) {
    $keeper = Start-Process wsl.exe -WindowStyle Hidden -ArgumentList '-d MiniStation -u root --exec sleep infinity' -PassThru
    $keeper.Id | Set-Content (Join-Path $PSScriptRoot 'keepalive.pid')
}

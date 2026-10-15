$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Keep-WSL-Running.ps1')
& wsl.exe -d MiniStation -u root --exec systemctl start docker
if ($LASTEXITCODE -ne 0) { throw 'Docker failed to start.' }
& wsl.exe -d MiniStation -u root --exec docker start ministation-control-plane ministation-worker ministation-worker2
if ($LASTEXITCODE -ne 0) { throw 'Cluster containers not found. Run Resume-Cluster.ps1 to install.' }
& wsl.exe -d MiniStation -u root --exec kubectl --context kind-ministation wait --for=condition=Ready nodes --all --timeout=180s
if ($LASTEXITCODE -ne 0) { throw 'Cluster nodes are not Ready.' }
& wsl.exe -d MiniStation -u root --exec kubectl --context kind-ministation get nodes -o wide

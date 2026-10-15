$ErrorActionPreference = 'Stop'
# This installer targets only the existing local kind test cluster.
# The kind overlay permits its self-signed kubelet certificates; do not use it in production.
$image = 'registry.k8s.io/metrics-server/metrics-server:v0.9.0'
& wsl.exe -d MiniStation -u root --exec docker inspect ministation-control-plane --format '{{.Name}}'
if ($LASTEXITCODE -ne 0) { throw 'Start the existing MiniStation kind cluster first.' }
& wsl.exe -d MiniStation -u root --exec docker pull $image
if ($LASTEXITCODE -ne 0) { throw 'Metrics Server image download failed.' }
& wsl.exe -d MiniStation -u root --exec docker image save --platform linux/amd64 -o /tmp/ministation-metrics-server.tar $image
if ($LASTEXITCODE -ne 0) { throw 'Metrics Server image export failed.' }
& wsl.exe -d MiniStation -u root --exec kind load image-archive /tmp/ministation-metrics-server.tar --name ministation
if ($LASTEXITCODE -ne 0) { throw 'Metrics Server image import failed.' }
foreach ($manifestName in @('metrics-server-kind.yaml', 'ministation-rbac.yaml')) {
    Get-Content -LiteralPath (Join-Path $PSScriptRoot $manifestName) -Raw | & wsl.exe -d MiniStation -u root --exec docker exec -i ministation-control-plane kubectl --kubeconfig=/etc/kubernetes/admin.conf apply -f -
    if ($LASTEXITCODE -ne 0) { throw "Failed to apply $manifestName" }
}
& wsl.exe -d MiniStation -u root --exec docker exec ministation-control-plane kubectl --kubeconfig=/etc/kubernetes/admin.conf -n kube-system rollout status deployment/metrics-server --timeout=60s
if ($LASTEXITCODE -ne 0) { throw 'Metrics Server is not ready; inspect its Pod events.' }
& wsl.exe -d MiniStation -u root --exec docker exec ministation-control-plane kubectl --kubeconfig=/etc/kubernetes/admin.conf top nodes

$env:MINISTATION_KUBE_URL = 'https://127.0.0.1:16443'
$env:MINISTATION_KUBE_TOKEN_FILE = Join-Path $PSScriptRoot 'credentials/controller.token'
$env:MINISTATION_KUBE_CA_FILE = Join-Path $PSScriptRoot 'credentials/ca.crt'

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
umask 077
mkdir -p credentials
kubectl --context kind-ministation -n ministation-workloads create token ministation-controller --duration=24h > credentials/controller.token
kubectl --context kind-ministation config view --raw --minify --flatten -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d > credentials/ca.crt
kubectl --context kind-ministation config view --raw --minify --flatten > credentials/kubeconfig
echo 'ServiceAccount token refreshed (requested lifetime: 24h). No credentials printed.'

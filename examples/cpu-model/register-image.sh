#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
image_ref=$(cat image-ref.txt)
for node in $(kind get nodes --name ministation); do
  docker exec "$node" ctr -n k8s.io images tag --force docker.io/library/ministation-cpu-model:1 "$image_ref"
done

#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd "$(dirname "$0")" && pwd)
resource=$(cat "$source_dir/service-name.txt")
exec kubectl -n ministation-workloads port-forward "service/$resource" 8801:8000 --address 127.0.0.1

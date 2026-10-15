#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
python3 train.py
docker build -t ministation-cpu-model:1 .
docker image save --platform linux/amd64 -o cpu-model.tar ministation-cpu-model:1
kind load image-archive cpu-model.tar --name ministation
# Containerd reports the OCI manifest digest used by Kubernetes image resolution.
docker exec ministation-control-plane ctr -n k8s.io images ls > images.txt
python3 - <<'PY'
import pathlib
lines=pathlib.Path('images.txt').read_text().splitlines()
line=next(l for l in lines if l.startswith('docker.io/library/ministation-cpu-model:1 '))
digest=next(x for x in line.split() if x.startswith('sha256:'))
pathlib.Path('image-ref.txt').write_text('docker.io/library/ministation-cpu-model@'+digest)
print('CPU model image pinned:',digest)
PY
bash register-image.sh

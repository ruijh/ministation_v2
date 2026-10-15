#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd "$(dirname "$0")" && pwd)
build_dir=/opt/ministation-jev-build
mkdir -p "$build_dir/model"
cp "$source_dir/service.py" "$source_dir/provenance.json" "$source_dir/Dockerfile.offline" "$build_dir/"
cp -a "$source_dir/vendor" "$build_dir/"
mkdir -p "$build_dir/runtime"
cp -au /opt/ministation-jev-venv/lib/python3.12/site-packages/. "$build_dir/runtime/"
find "$source_dir/model" -maxdepth 1 -type f ! -name '*.part' ! -name 'model.safetensors' -exec cp -t "$build_dir/model" {} +
expected=f47f71177f32bcd101b7573ec9171e6a57f4f4d31148d38e382306f42996874b
actual=$(sha256sum "$build_dir/model/model.safetensors" 2>/dev/null | cut -d' ' -f1 || true)
if [[ "$actual" != "$expected" ]]; then
  cp "$source_dir/model/model.safetensors" "$build_dir/model/"
fi
echo "$expected  $build_dir/model/model.safetensors" | sha256sum -c -
/opt/ministation-jev-venv/bin/pip freeze > "$source_dir/requirements.txt"
docker build -f "$build_dir/Dockerfile.offline" -t ministation-jev-cpu:1 "$build_dir"
docker image save --platform linux/amd64 -o /opt/ministation-jev-cpu.tar ministation-jev-cpu:1
# Sequential imports avoid overwhelming the single WSL disk and API leases.
for node in $(kind get nodes --name ministation); do
  kind load image-archive /opt/ministation-jev-cpu.tar --name ministation --nodes "$node"
done
docker exec ministation-control-plane ctr -n k8s.io images ls > "$build_dir/images.txt"
digest=$(awk '$1=="docker.io/library/ministation-jev-cpu:1" {print $3}' "$build_dir/images.txt")
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'No valid image digest'; exit 1; }
image_ref="docker.io/library/ministation-jev-cpu@$digest"
for node in $(kind get nodes --name ministation); do
  docker exec "$node" ctr -n k8s.io images tag --force docker.io/library/ministation-jev-cpu:1 "$image_ref"
done
printf '%s\n' "$image_ref" > "$source_dir/image-ref.txt"
echo "Pinned image: $image_ref"

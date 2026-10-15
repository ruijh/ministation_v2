#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export DEBIAN_FRONTEND=noninteractive
export http_proxy="${http_proxy:-${HTTP_PROXY:-}}"
export https_proxy="${https_proxy:-${HTTPS_PROXY:-}}"
export no_proxy="localhost,127.0.0.1,::1,.svc,.cluster.local,10.96.0.0/12,10.244.0.0/16,172.16.0.0/12"
apt-get update
apt-get install -y ca-certificates curl gpg python3
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable' > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
if [[ -n "$https_proxy" || -n "$http_proxy" ]]; then
  # Docker's systemd service does not inherit the interactive WSL proxy environment.
  python3 - <<'PY'
import os,json,pathlib
p=pathlib.Path('/etc/docker/daemon.json')
config=json.loads(p.read_text()) if p.exists() else {}
config['proxies']={'http-proxy':os.environ.get('http_proxy',''),'https-proxy':os.environ.get('https_proxy',''),'no-proxy':os.environ['no_proxy']}
p.parent.mkdir(parents=True,exist_ok=True)
p.write_text(json.dumps(config,indent=2))
PY
  systemctl restart docker
fi
systemctl enable --now docker
mkdir -p downloads
KIND_VERSION=v0.33.0
curl -fsSL --retry 3 "https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-linux-amd64" -o downloads/kind-linux-amd64
curl -fsSL --retry 3 "https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-linux-amd64.sha256sum" -o downloads/kind-linux-amd64.sha256sum
(cd downloads && sha256sum -c kind-linux-amd64.sha256sum)
install -m 0755 downloads/kind-linux-amd64 /usr/local/bin/kind
if ! kind get clusters | grep -qx ministation; then
  env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy kind create cluster --name ministation --config kind.yaml --wait 300s
fi
docker start ministation-control-plane ministation-worker ministation-worker2 > /dev/null
docker pull busybox:1.37.0
docker image save --platform linux/amd64 -o downloads/busybox-amd64.tar busybox:1.37.0
kind load image-archive downloads/busybox-amd64.tar --name ministation
# Use the kubectl version shipped with the cluster node, avoiding client/server skew.
docker cp ministation-control-plane:/usr/bin/kubectl /usr/local/bin/kubectl
chmod 0755 /usr/local/bin/kubectl
kind export kubeconfig --name ministation
kubectl wait --for=condition=Ready nodes --all --timeout=300s
kubectl -n kube-system rollout status deployment/coredns --timeout=300s
kubectl -n local-path-storage rollout status deployment/local-path-provisioner --timeout=300s
kubectl apply -f workloads.yaml
kubectl apply -f ministation-rbac.yaml
kubectl -n ministation-validation rollout status deployment/placement-check --timeout=300s
kubectl -n ministation-validation get pods -o wide
kubectl get nodes -o wide
kubectl get --raw='/readyz?verbose'
bash refresh-credentials.sh
test "$(kubectl auth can-i get secrets --as=system:serviceaccount:ministation-workloads:ministation-controller -n ministation-workloads)" = no
test "$(kubectl auth can-i create deployments --as=system:serviceaccount:ministation-workloads:ministation-controller -n ministation-workloads)" = yes
kubectl get nodes -o json > nodes-validation.json
kubectl -n ministation-validation get pods -o json > pods-validation.json
python3 - <<'PY'
import json,subprocess
nodes=json.load(open('nodes-validation.json'))['items']
pods=json.load(open('pods-validation.json'))['items']
assert len(nodes)==3, 'Expected three nodes'
assert len(pods)==2 and len({p['spec']['nodeName'] for p in pods})==2, 'Expected pods on two workers'
a,b=pods
def wget(url):
    return subprocess.check_output(['kubectl','-n','ministation-validation','exec',a['metadata']['name'],'--','wget','-T','15','-qO-',url],text=True).strip()
assert wget('http://'+b['status']['podIP']+':8080')==b['metadata']['name'], 'Cross-node Pod network failed'
assert wget('http://placement-check.ministation-validation.svc.cluster.local:8080') in {p['metadata']['name'] for p in pods}, 'Service DNS/routing failed'
print('PASS: three Ready nodes; replicas on separate workers; cross-node HTTP and Service DNS/routing.')
PY

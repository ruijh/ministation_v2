#!/usr/bin/env bash
# 在宿主机 shell 执行：为 MiniStation 本机部署安装 vLLM（CUDA）到 .venv-vllm。
# 说明：会话内因网络限速无法完成此安装，需在宿主机上运行本脚本（网络更快）。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
echo ">> 项目根: $ROOT"
[ -d /usr/local/cuda/bin ] && echo ">> 检测到 CUDA Toolkit: $(/usr/local/cuda/bin/nvcc --version | tail -1)"
echo ">> 创建 venv 并安装 vLLM（约 4GB 下载，请耐心等待）…"
python3 -m venv "$ROOT/.venv-vllm" || { echo "venv 创建失败"; exit 1; }
export PIP_DISABLE_PIP_VERSION_CHECK=1
PIP="$ROOT/.venv-vllm/bin/pip"
MIRRORS=(
 "https://pypi.tuna.tsinghua.edu.cn/simple"
 "https://mirrors.aliyun.com/pypi/simple"
 "https://mirrors.cloud.tencent.com/pypi/simple"
)
install() { "$@" -i "${MIRRORS[0]}" --timeout 60 --retries 3; }
"$PIP" install --upgrade pip 2>&1 | tail -1
done_=0
for idx in 0 1 2; do
 echo ">> 使用镜像: ${MIRRORS[$idx]}"
 if "$PIP" install -q vllm -i "${MIRRORS[$idx]}" --timeout 60 --retries 3 2>&1 | tail -6; then done_=1; break; fi
 sleep 2
done
[ "$done_" = 1 ] || { echo "vLLM 安装失败，请检查网络或改用手动 pip install vllm"; exit 1; }
"$ROOT/.venv-vllm/bin/python" -c "import vllm,torch;print('vllm',vllm.__version__,'torch',torch.__version__)"
echo
echo "==================== 完成 ===================="
echo "在宿主机 nvidia-smi 正常的前提下，重启 MiniStation 并设置："
echo "  MINISTATION_LOCAL_VLLM_BIN=\"$ROOT/.venv-vllm/bin/python -m vllm.entrypoints.openai.api_server\""
echo "然后 服务部署→本机部署→新建部署：引擎 vLLM、模型选 /home/DeepSeek-V4-Flash（或 Qwen3-30B-A3B）、GPU 数量 2。"

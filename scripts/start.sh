#!/usr/bin/env bash
# MiniStation 启动脚本（本机 GPU 部署版）
# 用法:  bash scripts/start.sh      （从项目根目录或任意位置执行）
#        先执行 bash scripts/stop.sh 可优雅停止（Ctrl+C 亦可）
# 说明：  HOST=0.0.0.0 让局域网可达；CUDA 版 llama.cpp 用于 GGUF 上卡；
#         若已运行过 scripts/setup-vllm.sh 则自动让 vLLM 引擎使用 .venv-vllm；
#         自动识别 CUDA 工具链（nvcc / ninja），供 vLLM 的 flashinfer / Triton JIT 编译使用。
set -uo pipefail
cd "$(dirname "$0")/.." || { echo "无法进入项目根目录（脚本应位于 MiniStation 的 scripts/ 下）"; exit 1; }

# 引导令牌：未预设时自动生成随机值并打印一次（首次初始化输入用），避免弱口令/固定口令
if [ -z "${MINISTATION_BOOTSTRAP_TOKEN:-}" ]; then
  MINISTATION_BOOTSTRAP_TOKEN="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | cut -c1-16)"
  echo ">> 首次初始化引导令牌: ${MINISTATION_BOOTSTRAP_TOKEN}（请妥善保存）"
fi
export MINISTATION_BOOTSTRAP_TOKEN
export HOST='0.0.0.0'
export PORT='8787'

# CUDA 版 llama-server（sm_90 / L20）：GGUF 引擎指定 GPU 数量 1-2 即自动 -ngl 999 上卡
export MINISTATION_LOCAL_LLAMACPP_BIN="${MINISTATION_LOCAL_LLAMACPP_BIN:-$PWD/artifacts/llama.cpp/build-cuda/bin/llama-server}"

# ---- GPU 可见性（CUDA_VISIBLE_DEVICES）：启动时自动识别，可见即可用 ----
# 自动读取 nvidia-smi 当前可见的全部 GPU 索引并设给 CUDA_VISIBLE_DEVICES（如 0,1 → TP=2 / 多卡可直接用）。
# 可选 MINISTATION_CUDA_DEVICES 覆盖（如 "0" 或 "1"），仍会与可见卡求交集，确保不引用不存在的设备；
# 无 GPU / nvidia-smi 不可用时跳过（CPU 模式）。
_devs=()
if command -v nvidia-smi >/dev/null 2>&1; then
  _idx="$(nvidia-smi --query-gpu=index --format=csv,noheader 2>/dev/null | grep -E '[0-9]+')"
  _ngpu="$(printf '%s\n' "$_idx" | grep -cE '[0-9]')"
  if [ "${_ngpu:-0}" -gt 0 ] 2>/dev/null; then
    _visible="$(printf '%s\n' "$_idx" | tr -d ' ' | sort -n | paste -sd, -)"
    if [ -n "${MINISTATION_CUDA_DEVICES:-}" ]; then
      IFS=',' read -r -a _devs <<< "$MINISTATION_CUDA_DEVICES"
      _vis=""
      for _d in "${_devs[@]}"; do
        _d="$(printf '%s' "$_d" | tr -d ' ')"
        [[ "$_d" =~ ^[0-9]+$ ]] || continue
        grep -qE "(^|,)${_d}(,|$)" <<< ",$_visible," && { _vis="${_vis:+$_vis,}${_d}"; }
      done
      _vis="${_vis:-$_visible}"
    else
      _vis="$_visible"
    fi
    export CUDA_VISIBLE_DEVICES="$_vis"
    echo ">> GPU 可见性: 自动识别 ${_ngpu} 卡 → CUDA_VISIBLE_DEVICES=${CUDA_VISIBLE_DEVICES}"
    unset _vis _visible _ngpu
  else
    echo ">> 未检测到可用 GPU（nvidia-smi 无设备）；不设置 CUDA_VISIBLE_DEVICES（CPU 模式）"
  fi
  unset _idx
fi
unset _devs

# 若已装 vLLM（scripts/setup-vllm.sh），让 vLLM 引擎使用该解释器（值为空格分隔的命令），
# 并把 venv 的 bin 放进 PATH：flashinfer / torch 的 JIT 靠子进程找 ninja 等工具，PATH 缺了就会降级。
if [ -x "$PWD/.venv-vllm/bin/python" ]; then
  export MINISTATION_LOCAL_VLLM_BIN="$PWD/.venv-vllm/bin/python -m vllm.entrypoints.openai.api_server"
  export PATH="$PWD/.venv-vllm/bin:$PATH"
fi

# ---- CUDA 工具链识别（nvcc；供 llama.cpp 之外的所有 GPU 引擎 / flashinfer JIT）----
# 优先级：显式 CUDA_HOME > /usr/local/cuda 软链 > 常见版本目录；找到即导出并补 PATH/LD_LIBRARY_PATH。
CUDA_HOME_V=""
for cand in "${CUDA_HOME:-}" /usr/local/cuda /usr/local/cuda-13.0 /usr/local/cuda-12 /usr/local/cuda-11 /opt/cuda; do
  [ -n "$cand" ] || continue
  if [ -x "$cand/bin/nvcc" ]; then CUDA_HOME_V="$(cd "$cand" && pwd)"; break; fi
done
if [ -n "$CUDA_HOME_V" ]; then
  export CUDA_HOME="$CUDA_HOME_V"
  export CUDA_PATH="$CUDA_HOME_V"
  export PATH="$CUDA_HOME_V/bin:$PATH"
  export LD_LIBRARY_PATH="$CUDA_HOME_V/lib64:$CUDA_HOME_V/lib:${LD_LIBRARY_PATH:-}"
  CUDA_VER="$("$CUDA_HOME_V/bin/nvcc" --version 2>/dev/null | awk '/release[ ,]/ {print $(NF); exit}')"
  echo ">> CUDA 工具链: $CUDA_HOME_V（nvcc ${CUDA_VER:-?}）"
else
  echo ">> 警告：未找到 CUDA 工具链（nvcc）。vLLM 的 flashinfer/JIT 无法启用，推理性能会下降。"
fi

# ---- ninja（flashinfer / torch JIT 编译需要；找不到就明确提示，避免静默降级）----
NINJA_BIN="$(command -v ninja 2>/dev/null || command -v ninja-build 2>/dev/null || true)"
if [ -z "$NINJA_BIN" ] && [ -x "$PWD/.venv-vllm/bin/ninja" ]; then NINJA_BIN="$PWD/.venv-vllm/bin/ninja"; fi
if [ -n "$NINJA_BIN" ]; then
  case "$NINJA_BIN" in */*) export PATH="$(dirname "$NINJA_BIN"):$PATH";; esac
  echo ">> ninja: $NINJA_BIN"
else
  echo ">> 警告：未找到 ninja。flashinfer JIT 需要 ninja + nvcc；可选其一："
  echo "   · 系统级:  sudo dnf install -y ninja-build"
  echo "   · 仅该项目: $PWD/.venv-vllm/bin/pip install ninja"
fi

# flashinfer JIT 编译缓存放到项目内（.cache/ 已加入 .gitignore），避免写家目录（权限/空间更可控）
if [ -d "$PWD/.venv-vllm" ]; then
  mkdir -p "$PWD/.cache/flashinfer"
  export FLASHINFER_WORKSPACE_DIR="${FLASHINFER_WORKSPACE_DIR:-$PWD/.cache/flashinfer}"
fi

# 模型扫描范围：/home（HF 模型目录）+ 项目内 GGUF 目录（artifacts/models）
export MINISTATION_MODEL_SCAN_ROOTS="${MINISTATION_MODEL_SCAN_ROOTS:-/home,$PWD/artifacts/models}"

echo ">> 项目目录: $PWD"
echo ">> 访问地址: http://<本机IP>:${PORT}  (HOST=${HOST})"
echo ">> GPU 自检: $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 | tr -d ' ' || echo '未检测到（CPU 模式）')"
echo ">> 启动 MiniStation（Ctrl+C 停止）…"
exec npm run start

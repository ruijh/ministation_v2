#!/usr/bin/env bash
# MiniStation 停止脚本（与 scripts/start.sh 配套）
# 用法:  bash scripts/stop.sh      （优雅停止，Ctrl+C 无需）
#         PORT=9000 bash scripts/stop.sh   （停止其它端口实例）
# 说明：  找到监听在 PORT（默认 8787）上的 MiniStation node 主进程，先发 SIGTERM 触发
#         优雅退出（server/index.mjs 的 stop() 会顺带终止它拉起的本机引擎进程：
#         llama-server / vLLM 等），等待后仍未退出再 SIGKILL。
set -uo pipefail

cd "$(dirname "$0")/.." || { echo "无法进入项目根目录（脚本应位于 MiniStation 的 scripts/ 下）"; exit 1; }
PORT="${PORT:-8787}"

echo ">> 停止 MiniStation（端口 ${PORT}）…"

# 找到监听在该端口上的主进程 PID（lsof → fuser → pgrep 依次兜底）
pids="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
if [ -z "$pids" ] && command -v fuser >/dev/null 2>&1; then
  pids="$(fuser "${PORT}/tcp" 2>/dev/null | sed 's/.*: *//; s/ */ /g' || true)"
fi
if [ -z "$pids" ] && command -v pgrep >/dev/null 2>&1; then
  pids="$(pgrep -f "server/index\.mjs|npm run start" 2>/dev/null || true)"
fi
pids="$(echo "$pids" | tr -s ' \n' ' ' | sed 's/^ *//; s/ *$//')"

if [ -z "$pids" ]; then
  echo ">> 没有发现运行中的 MiniStation（端口 ${PORT} 未被占用或进程不存在）。"
  exit 0
fi

for pid in $pids; do
  case "$pid" in ''|*[!0-9]*) continue;; esac
  kill -0 "$pid" 2>/dev/null || continue
  echo ">> 发送 SIGTERM → PID ${pid}（触发优雅退出，含本机引擎进程停止）"
  kill -TERM "$pid" 2>/dev/null || { echo "  无法结束 PID ${pid}（权限不足？尝试：sudo bash $0）"; continue; }
done

# 等待优雅退出（最多 ~10s），仍未退出则 SIGKILL
for _ in $(seq 1 20); do
  alive=""
  for pid in $pids; do
    case "$pid" in ''|*[!0-9]*) continue;; esac
    if kill -0 "$pid" 2>/dev/null; then alive="$alive $pid"; fi
  done
  [ -z "$alive" ] && break
  sleep 0.5
done

for pid in $pids; do
  case "$pid" in ''|*[!0-9]*) continue;; esac
  if kill -0 "$pid" 2>/dev/null; then
    echo ">> 优雅退出超时，发送 SIGKILL → PID ${pid}"
    kill -KILL "$pid" 2>/dev/null || true
  fi
done

sleep 0.5
if command -v lsof >/dev/null 2>&1 && lsof -ti "tcp:${PORT}" >/dev/null 2>&1; then
  echo ">> 警告：端口 ${PORT} 仍被占用，请检查：lsof -i tcp:${PORT}"
  exit 1
fi
echo ">> MiniStation 已停止，端口 ${PORT} 已释放。"

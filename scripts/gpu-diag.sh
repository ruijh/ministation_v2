#!/usr/bin/env bash
# MiniStation GPU 诊断 / 修复脚本（scripts/gpu-diag.sh）
# 说明：在宿主机 root 下执行；默认只读诊断，加 fix 才进入带确认的修复步骤。
# 用法：
#   sudo bash scripts/gpu-diag.sh            # 只诊断（只读，安全）
#   sudo bash scripts/gpu-diag.sh fix        # 诊断 + 修复（模块重载 / 驱动升级 / PCIe 检查，均带确认）
# 输出同时写入当前目录 gpu-diag-<时间戳>.log，方便回贴排查。
# 处置顺序摘要：① 重启整机 → ② scripts/setup-gpu-driver.sh 重装驱动后再重启
#              → ③ GSP 绕行（options nvidia NVreg_EnableGpuFirmware=0）→ ④ 硬件层（插拔/换槽/刷 VBIOS/保修）
set -uo pipefail

LOG="gpu-diag-$(date +%Y%m%d-%H%M%S).log"
touch "$LOG"
echo ">> 输出同时写入: $LOG"
[ "$(id -u)" -eq 0 ] || echo ">> 提示：读内核日志 / 重载模块需要 root，建议 sudo bash $0 [fix]"

step(){ echo; echo "===== $* ====="; echo "===== $* =====" >> "$LOG"; }
do_cmd(){
  echo "\$ $*"
  echo "\$ $*" >> "$LOG"
  "$@" 2>&1 | tee -a "$LOG"
  echo "[退出码 ${PIPESTATUS[0]}]" | tee -a "$LOG"
}
ask(){ local ans; read -r -p "$1 [y/N] " ans; case "$ans" in y|Y) return 0;; *) return 1;; esac; }

PHYS_GPUS=0
[ -d /proc/driver/nvidia/gpus ] && PHYS_GPUS=$(ls -1 /proc/driver/nvidia/gpus 2>/dev/null | wc -l)
LIVE_GPUS=0
LIVE_GPUS=$(nvidia-smi -L 2>/dev/null | grep -c "GPU" ) || true

echo ">> 时间: $(date '+%F %T')；内核: $(uname -r)；/proc 登记 GPU 数: $PHYS_GPUS"

step "① 当前可见 GPU（nvidia-smi -L）"
do_cmd nvidia-smi -L

step "①b 明细 index/型号/总线/显存"
do_cmd nvidia-smi --query-gpu=index,name,pci.bus_id,memory.total --format=csv
do_cmd ls -1 /proc/driver/nvidia/gpus

step "② NVRM / RmInitAdapter 失败上下文（内核日志，最近 30 条）"
if command -v dmesg >/dev/null 2>&1 && timeout 10 dmesg >/dev/null 2>&1; then
  do_cmd bash -c "dmesg 2>/dev/null | grep -iE 'NVRM|RmInitAdapter' | tail -30"
else
  echo "（dmesg 不可读，退用 journalctl，最多等 25 秒）"; echo "（dmesg 不可读，退用 journalctl）" >> "$LOG"
  do_cmd bash -c "timeout 25 journalctl -kb --no-pager 2>/dev/null | grep -iE 'NVRM|RmInitAdapter' | tail -30 || true"
fi

step "③ 驱动版本 / 模块 / 关键参数"
do_cmd cat /proc/driver/nvidia/version
do_cmd bash -c "grep -i nvidia /proc/modules 2>/dev/null | awk '{print \$1, \$3}'"
do_cmd bash -c "grep -E 'EnableGpuFirmware|PreserveVideoMemoryAllocations|EnableUserNUMAManagement' /proc/driver/nvidia/params 2>/dev/null"

step "④ 结论提示（物理 vs 可见卡数）"
{
  echo "   /proc 登记: $PHYS_GPUS  张；nvidia-smi 可见: $LIVE_GPUS  张"
  if [ "$LIVE_GPUS" -lt "$PHYS_GPUS" ]; then
    echo "   ⚠ 可见 < 物理：存在 RmInitAdapter 失败的卡（多为某卡 GSP 固件 boot 超时，见第②步日志）"
    echo "   → 处置：① 重启整机 → ② sudo bash scripts/setup-gpu-driver.sh 重装驱动后再重启"
    echo "        → ③ GSP 绕行 options nvidia NVreg_EnableGpuFirmware=0 → ④ 硬件层（插拔/换槽/刷 VBIOS/保修）"
  else
    echo "   ✓ 可见 == 物理，GPU 全部上线"
  fi
  echo "   （完整记录见 $LOG）"
} | tee -a "$LOG"

if [ "${1:-}" = "fix" ]; then
  step "⑤ 检查是否有引擎/控制面占用 GPU（占有时不要重载）"
  do_cmd pgrep -af "vllm|llama-server|server/index"
  echo "---- 若上面有进程，请先 bash scripts/stop.sh 停止后再重载 ----"

  if ask "继续模块重载（modprobe -r nvidia* 后重新加载）？"; then
    step "⑥ 模块卸载→加载"
    for m in nvidia_uvm nvidia_drm nvidia_modeset nvidia; do modprobe -r "$m" 2>/dev/null || true; done
    modprobe nvidia && sleep 2
    modprobe nvidia_uvm nvidia_modeset nvidia_drm 2>/dev/null || true
    do_cmd nvidia-smi -L
  fi

  if ask "重装 / 升级驱动（scripts/setup-gpu-driver.sh → 595.104.02）？"; then
    step "⑦ 驱动重装"
    do_cmd bash scripts/setup-gpu-driver.sh
    echo ">> 装完建议重启整机，再运行本脚本验证 nvidia-smi -L"
  fi

  if ask "检查 PCIe 链路（01:00.0 / 81:00.0）？"; then
    step "⑧ PCIe 链路"
    do_cmd lspci -s 01:00.0 -v
    do_cmd lspci -s 81:00.0 -v
  fi
  echo; echo ">> fix 步骤完成。仍只有 1 张就重启整机；再不行多半是硬件 / 槽位 / VBIOS 问题。"
else
  echo; echo ">> 只读诊断完成（未改动任何东西）。完整结果见: $LOG"
  echo ">> 需要进入修复步骤时执行: sudo bash $0 fix"
fi
echo ">> 完成，日志: $LOG"

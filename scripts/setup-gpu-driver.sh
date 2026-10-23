#!/usr/bin/env bash
# 在宿主机 root 下运行：安装最新 NVIDIA 生产驱动（595.104.02），适配 L20（10de:26ba，AD102）。
# 当前会话沙箱为只读根，无法改写 /usr /lib/modules /dev，须由管理员在本机 shell 执行本脚本。
set -euo pipefail
VERSION="${1:-595.104.02}"
URL="https://download.nvidia.com/XFree86/Linux-x86_64/${VERSION}/NVIDIA-Linux-x86_64-${VERSION}.run"
KVER="$(uname -r)"
[ "$(id -u)" -eq 0 ] || { echo "请以 root 运行: sudo bash $0"; exit 1; }
echo ">> 内核: $KVER  版本: $VERSION"
[ -e "/lib/modules/$KVER/build" ] || { echo "缺少 $KVER 内核头文件（/lib/modules/$KVER/build）；先装 kernel-devel 或补齐编译树。"; exit 1; }
echo ">> 下载驱动…"
RUN="/tmp/NVIDIA-Linux-x86_64-${VERSION}.run"
echo ">> /tmp 剩余空间: $(df -h /tmp | awk 'NR==2{print $4}')"
run_ok(){ [ -s "$1" ] && sh "$1" --version >/dev/null 2>&1; }
ok_=0
for i in 1 2 3; do
  if run_ok "$RUN"; then ok_=1; break; fi
  echo ">> [第 ${i} 次] 安装包缺失或校验不通过（可能上次下载残包），删除并重新下载…"
  rm -f "$RUN"
  curl -fL --retry 3 --connect-timeout 30 -o "$RUN" "$URL" || { echo "下载失败，稍后重试…"; sleep 2; continue; }
done
[ "$ok_" = 1 ] || {
  echo ">> 多次下载仍校验失败；请检查网络 / /tmp 空间后手动执行："
  echo "   rm -f $RUN"
  echo "   curl -fL -o $RUN '$URL' && sh $RUN --version   # 应打印驱动版本号"
  echo "   然后再跑 sudo bash $0"
  exit 1; }
chmod +x "$RUN"
echo ">> 安装包校验通过: $RUN（$(ls -l "$RUN" | awk '{print $5}') 字节）"
echo ">> 卸载旧 nvidia 模块（如有）并安装（静默、无 X、不出 GL）…"
rmmod nvidia_drm nvidia_modeset nvidia_uvm nvidia 2>/dev/null || true
yum -y install gcc make dkms 2>/dev/null || dnf -y install gcc make dkms 2>/dev/null || true
"/tmp/NVIDIA-Linux-x86_64-${VERSION}.run" --silent --dkms --no-x-check --no-opengl-files --no-cc-version-check --no-nouveau-check || {
  echo "静默安装失败，改交互安装…"; "/tmp/NVIDIA-Linux-x86_64-${VERSION}.run" --no-x-check --no-opengl-files; exit 1; }
echo ">> 加载模块并验证…"
modprobe nvidia 2>/dev/null || true
[ -e /dev/nvidiactl ] || mknod /dev/nvidiactl c 195 255 2>/dev/null || true
nvidia-smi || { echo "nvidia-smi 尚未就绪，尝试 nvidia-modprobe"; nvidia-modprobe -u 2>/dev/null || true; nvidia-smi; }
echo
echo "==================== 完成 ===================="
echo "验证: nvidia-smi 应列出 2× NVIDIA L20 48GB"
echo "MiniStation 侧：重启时保持 MINISTATION_LOCAL_LLAMACPP_BIN（CUDA 版）或先 pip install vllm，"
echo "然后 服务部署→本机部署→新建部署：引擎 vLLM/llama.cpp、GPU 数量 1-2，指向 /home/DeepSeek-V4-Flash。"

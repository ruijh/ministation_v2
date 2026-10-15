# Windows / WSL Kubernetes 测试环境

目标：在专用 `MiniStation` WSL 2 发行版中运行 Ubuntu 24.04、Docker Engine 和 kind，提供 1 个控制节点及 2 个工作节点。三个节点是同一 WSL 虚拟机中的容器，可以验证调度、隔离和 Kubernetes API；不能替代多物理机故障域、GPU 或生产高可用验收。

本机初次安装时将 `wslconfig.ini` 复制到用户目录 `.wslconfig`：WSL 总内存上限 12 GB、6 个逻辑处理器，启用 mirrored 网络、DNS 隧道与自动代理。该文件为 WSL 全局配置，未来其他 WSL 2 发行版也共享这些设置。修改后需停止 WSL 虚拟机才能生效。

## 安装与续跑

以下 PowerShell 命令均在 MiniStation 项目根目录执行。

Windows 安装入口为 `Install-WSL.ps1`（需管理员权限）；官方 MSI 备用入口为 `Install-WSL-MSI.ps1`。安装程序禁止自动重启。如果安装结果要求重启，请先保存其他工作，再手动重启 Windows。

Ubuntu 镜像与官方 SHA256SUMS 放在本目录。普通 PowerShell 执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\infra\wsl\Resume-Cluster.ps1
```

该脚本校验镜像，导入专用发行版到本目录的 `distro`，启用 systemd，再安装 Docker 和 kind。已存在的同名发行版、集群会复用。不会注销发行版或删除集群。首次下载网络失败时可重跑；失败原因见日志。

## 使用

```powershell
wsl -d MiniStation -u root -- kubectl get nodes -o wide
wsl -d MiniStation -u root -- kubectl get pods -A
wsl -d MiniStation -u root -- kubectl -n ministation-validation get pods -o wide
```

集群 API 绑定 `https://127.0.0.1:16443`，供 Windows 本机使用；不开放到局域网。WSL 启动后 Docker 通过 systemd 启动。Windows 重启或停止 WSL 后，运行本目录 `Start-Cluster.ps1` 启动现有节点并等待 Ready。

启动脚本在 Windows 后台保留一个 `wsl ... sleep infinity` 进程，避免 WSL 在只有 systemd 服务时自动休眠。它不会开机自动运行；停止该发行版时随之结束。

完成安装后，在启动 MiniStation 的同一个 PowerShell 中加载生成的环境文件：

```powershell
. .\infra\wsl\Use-Cluster.ps1
# 在 MiniStation 项目根目录执行
npm.cmd start
```

应用使用 `ministation-workloads` 命名空间，配额为请求 CPU 4 核、内存 8 GiB，限制 CPU 8 核、内存 12 GiB、Pod 30 个。应用项目配额应相应配置，不应高于实际集群配额。

`credentials` 目录由 Windows ACL 限制为当前用户与 SYSTEM。包含管理员 kubeconfig、CA 和受限 ServiceAccount Token，已排除版本控制。Token 请求有效期为 24 小时；实际有效期由 API Server 决定。续期：

```powershell
$scriptPath = (Resolve-Path './infra/wsl/refresh-credentials.sh').Path
$wslScriptPath = (wsl -d MiniStation --exec wslpath -a $scriptPath).Trim()
wsl -d MiniStation -u root --exec bash "$wslScriptPath"
```

ServiceAccount 可管理指定命名空间中的工作负载、读取配额，以及读取/设置节点调度状态；没有直接读取 Secret、修改 RBAC 或管理其他命名空间的权限。此测试控制器权限不能代替企业版完整的策略准入与租户隔离。

## 验收记录

安装脚本成功时检查：3 个节点 Ready；测试 Deployment 的 2 个副本分布在不同 worker；跨节点 HTTP 与 Service DNS 可用；API readyz 成功；ServiceAccount 不能读取 Secret、可以创建 Deployment。结果保存在 `nodes-validation.json`、`pods-validation.json` 和 `cluster-install.log`。本次实际验收结果见 [VALIDATION.md](VALIDATION.md)。文件存在不等于最新验收通过，应以日志最后一次执行的结果为准。

Windows 侧验证：

```powershell
# 在 MiniStation 项目根目录执行
node infra/wsl/verify-windows.mjs
```

停止以释放内存：`wsl --terminate MiniStation`。再次运行 `Start-Cluster.ps1` 恢复。

参考：[WSL 命令](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)、[Docker Ubuntu 安装](https://docs.docker.com/engine/install/ubuntu/)、[kind 配置](https://kind.sigs.k8s.io/docs/user/configuration/)。

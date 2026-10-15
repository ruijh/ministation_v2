# 安装与验证记录

验收日期：2026-10-14，Windows 本机实际执行。

## 已安装

| 项目 | 实际结果 |
| --- | --- |
| WSL | 3.0.3.0，安装返回码 0，无需重启 Windows |
| Linux | Ubuntu 24.04，发行版名称 MiniStation，WSL 2 |
| Linux 内核 | 6.18.54.1-microsoft-standard-WSL2 |
| systemd | PID 1 已验证 |
| 资源上限 | 12 GB 内存、6 个逻辑处理器 |
| Docker Engine | 29.9.0 |
| kind | v0.33.0，下载校验和通过 |
| Kubernetes | v1.37.0，节点镜像 digest 已固定在 kind.yaml |
| 节点 | ministation-control-plane、ministation-worker、ministation-worker2 |
| API | https://127.0.0.1:16443 |
| 磁盘 | 本目录 distro/ext4.vhdx，安装后约 5.76 GiB，可继续增长 |

## 实际通过的检查

- 三个节点全部 Ready；CoreDNS、kindnet、kube-proxy、local-path-provisioner 正常运行。
- Kubernetes `/readyz?verbose` 所有检查通过。
- 测试 HTTP Deployment 的两个副本分布在两个不同工作节点。
- 从一个测试 Pod 访问另一工作节点的 Pod IP，收到对应 Pod 的 HTTP 响应。
- 从 Pod 通过完整 Service DNS 名称访问服务成功。
- Windows Node.js 客户端通过 HTTPS 和 CA 校验访问集群成功，读取到三个 Ready 节点。
- 项目命名空间 ResourceQuota 存在。
- ServiceAccount 可创建本项目 Deployment；直接读取 Secret、读取 kube-system Pod 均被拒绝（403）。
- MiniStation `server/kubernetes.mjs` 适配器实际执行 `assertQuota`、`nodes` 成功。
- `Start-Cluster.ps1` 对已有集群执行成功，并等待三个节点 Ready。

原始结果见 `cluster-install.log`、`nodes-validation.json`、`pods-validation.json`、`windows-validation.json`。凭据不写入本报告。

## 修复记录与边界

- 已修复 PowerShell 到 WSL 的路径/引号传递问题，配置文件通过文件复制写入。
- Docker containerd 镜像存储直接使用 kind load docker-image 时触发多架构内容缺失；改为导出 linux/amd64 镜像归档后导入，测试成功。
- 用后台 WSL sleep 进程维持发行版运行；停止发行版可同时结束此进程。未创建 Windows 开机计划任务。
- 当前是同一 Windows 主机中的三个容器节点，用于 CPU 工作负载、调度、API、网络和权限测试。尚未验证 GPU、跨物理机故障、高可用或断电恢复。
- ServiceAccount Token 请求有效期 24 小时，过期后运行 refresh-credentials.sh；这不是长期生产凭据方案。
- 本次已提供 MiniStation 集群接入配置，但不代表 MiniStation 全部产品功能或真实模型推理已验收。

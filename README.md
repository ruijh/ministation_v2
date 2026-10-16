# MiniStation

面向私有化模型部署与调用的轻量级推理平台，当前为本地开发验证版。代码、测试、容器配置与交付文档均保存在本目录。

**当前为开发验证版。** 功能边界见 [需求覆盖表](docs/COVERAGE.md)。

## 本机启动

以下命令均在 MiniStation 项目根目录执行。

要求 Node.js 24+。首次运行先安装依赖并构建网页：

```powershell
npm.cmd ci
npm.cmd run build
```

启动后访问 <http://127.0.0.1:8787>。

```powershell
# Windows 重启后先恢复 Kubernetes
powershell -ExecutionPolicy Bypass -File .\infra\wsl\Start-Cluster.ps1
# 在另一个 PowerShell 中启动控制台与 API
powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1
```

首次访问由用户设置管理员账号，不内置固定密码。默认项目使用 `ministation-workloads` 命名空间、4 核 / 8 GiB 配额，GPU 配额为 0。界面不预置虚假的服务和用量。

`start-local.ps1` 读取 Kubernetes 本地配置、限制数据目录 Windows ACL，并允许 `api.minimaxi.com`、`127.0.0.1`、`localhost` 三个上游主机。其他主机需要由管理员调整 `MINISTATION_UPSTREAM_HOSTS`。上游凭据使用 AES-256-GCM 加密保存，平台 Key 只保存哈希。不要删除 `data/master.key`。

## 接入 MiniMax

1. 在“接入服务”选择“接入模型服务”。已预填 Base URL `https://api.minimaxi.com/v1`、模型 `MiniMax-M3`。
2. 在本地输入上游 API Key、确认实际费率后保存。Key 不需要发到聊天里。
3. 执行连接测试，成功后发布逻辑模型，例如 `minimax-m3`。测试会调用上游。
4. 在“访问密钥”创建仅授权此模型的平台 Key，立即保存一次性显示的密钥。
5. 在“在线调试”输入平台 Key 并调用；在“用量账本”检查结果。

统一入口为 `/v1/chat/completions`、`/v1/embeddings`、`/v1/models`。使用 `Authorization: Bearer <平台 Key>`。不要将上游 Key 当作平台 Key。

## 轻量工作台

主导航为运行总览、模型资产、服务部署、在线调试、监控告警和平台设置。相关页面在各入口内切换，分布式、灰度、策略和原生资源等高级功能按需展开。

大模型向导先检测目标集群与项目可用资源，再给出保守单卡配置；无 GPU 或无法检测时明确提示，不自动提高配额。已有模板提供容量与策略适配提示，镜像和模型硬件兼容性仍需验证。服务详情集中状态、日志、诊断与接入发布。详见 [部署与调用指南](docs/DEPLOYMENT-GUIDE.md)。

## 已实现功能

- 管理员初始化、登录、改密、用户创建、项目隔离和管理员/开发者/只读角色。
- 模型外部引用、本地目录不可变快照、文件清单与 SHA-256。
- vLLM / SGLang 大模型部署向导；自动生成启动参数，校验 TP/GPU、模型卷、节点容量和项目策略；保留镜像与 AI 手动部署入口。
- 部署与分布式模型组的接入发布引导：自动填写关联、地址和模型名，真实连接验证后发布。
- Kubernetes Deployment / Service 创建、任务记录、状态同步、修订、回滚、停止恢复、删除、Pod 诊断和日志。
- 受限原生 YAML 服务端 dry-run、创建与按 UID 回退；包含 PVC 时禁止自动回退删除数据。
- 串行、融合、流量、条件及决策路由编排节点；树形嵌套校验与不可变服务流记录。
- 服务探测、逻辑模型发布、Key 授权、RPM/TPM/预算预占、Chat/SSE/Embedding/Decision 网关。
- 真实上游 usage 入账、费率计算、缺失 usage 待核对、人工核对审计、CSV 导出。
- 集群节点与调度开关；本地数据库和加密凭据备份/恢复、结构版本检查与隔离恢复演练。
- 通用 Webhook 告警通知：加密凭据、签名、有限重试和投递记录。
- 项目级 FIFO 请求队列：并发与等待上限、超时取消、出队权限及预算复核。

## 运行管理

- “服务部署 → 大模型部署”：选择引擎、模型卷与资源，预检后保存草稿；部署完成后使用“接入与发布”。操作步骤见 [部署与调用指南](docs/DEPLOYMENT-GUIDE.md)。
- “服务部署 → 服务详情 → 诊断”：查看镜像、模型卷、调度、内存和探针故障的依据与处理建议。
- “服务部署 → 更多操作 → 保存模板”：从已就绪服务保存配置；“部署模板 → 使用模板”回填新部署草稿。
- “服务部署 → 服务详情 → 运行状态”：查看后台 Kubernetes 观测、故障建议和持久时间线。控制面重启后自动核对，保留中断任务供检查。
- “服务指标”：查看最近 24 小时请求数、失败率、P95 延迟、首 Token 和小时趋势；仅使用真实账本记录，排除编排子调用重复计数。
- 更新后需重新启动控制台进程，后台观测器才会启用；界面静态资源通过 `npm run build` 更新。

## 资源治理、监控与发布

通过“资源池与容量”“项目策略”“监控告警”“发布管理”“弹性伸缩”页面管理：

- 项目节点池、真实容量/申请量，以及统一部署策略。
- Prometheus / Metrics Server / DCGM 数据适配与控制台阈值告警。
- 候选版本灰度、指标自动回退、明确 HTTP 拒绝后的备用切换和 SSE 排空。
- CPU 或每副本在途请求驱动的弹性伸缩，包含冷却、配额预检与缩容排空。

运行边界、功能说明、安装与验收见 [资源治理与运维说明](docs/OPERATIONS.md)。本地 Metrics Server 安装脚本为 `infra/wsl/Install-Metrics.ps1`；生产监控可通过 `MINISTATION_PROMETHEUS_URL` 接入已有 Prometheus。GPU 采集尚无本机硬件验收。

## 测试

要求 Node.js 24+，安装依赖执行 `npm.cmd ci`。

```powershell
# 在 MiniStation 项目根目录执行
npm.cmd run check
npm.cmd run test:e2e
node scripts/verify-cluster.mjs
```

浏览器测试默认使用本机 Edge 的独立无头实例，不访问用户浏览器配置。其他环境可设置 `PLAYWRIGHT_CHANNEL` 为已安装的 Playwright 浏览器通道。

测试上游 `scripts/fixture.mjs` 只生成合成协议响应，不是模型。真实 CPU 分类验收使用 `examples/cpu-model` 中训练并容器化的朴素贝叶斯模型，通过真实 Kubernetes、统一网关和用量账本验证。该小模型用于功能验收，不代表通用语言理解能力。

重新构建 CPU 验收镜像：

```powershell
$scriptPath = (Resolve-Path './examples/cpu-model/build.sh').Path
$wslScriptPath = (wsl -d MiniStation --exec wslpath -a $scriptPath).Trim()
wsl -d MiniStation -u root --exec bash "$wslScriptPath"
```

集群测试使用独立测试数据库，并在结束时删除自己创建的部署和 Service，不修改用户控制台数据。验收结果：`artifacts/cluster/validation.json`；浏览器截图：`artifacts/e2e/`。

## 备份与恢复

```powershell
npm.cmd run backup
# 停止应用后，将备份恢复到一个不存在的新目录
node scripts/backup.mjs restore data/backups/<时间目录> data-restored
# 然后通过 MINISTATION_DATA_DIR 指向恢复目录启动
```

备份使用 SQLite 在线备份 API，包含匹配的 `master.key` 与已登记模型快照，生成校验清单。恢复检查哈希与数据库完整性，禁止覆盖已有目录。备份不包含 Kubernetes 持久卷、外部模型仓库或上游供应商数据，应单独备份。

## 容器交付

根目录 Dockerfile 提供 Linux 镜像构建入口。首次构建需要访问 npm 和基础镜像仓库；容器镜像构建与完整断网安装尚未验收。运行时必须挂载持久 `/data`，并设置 `MINISTATION_BOOTSTRAP_TOKEN` 才能绑定非回环地址。Kubernetes Token / CA 使用只读文件挂载，并通过环境变量指定。企业暴露服务前应配置 HTTPS 反向代理；当前本机入口仅监听 127.0.0.1。

更多：[API 边界](docs/API.md) · [需求覆盖与限制](docs/COVERAGE.md) · [验证记录](docs/VALIDATION.md) · [WSL 集群说明](infra/wsl/README.md)。

## CPU 决策服务

支持 JEV-CPU / Qwen3-0.6B 纯 CPU 决策接入、结构化调试与决策路由。统一入口为 /v1/decisions；详细协议、部署和限制见 [决策服务](docs/DECISIONS.md)。


## 许可证

MiniStation 使用 [MIT License](LICENSE)。第三方代码与模型保留各自的许可证；参见 `examples/jev-cpu/vendor/LICENSE`、`examples/jev-cpu/vendor/THIRD_PARTY.md` 和 `examples/jev-cpu/provenance.json`。模型权重不随源码分发。

## 实验性分布式推理

“工作空间 → 分布式推理”提供 SGLang / vLLM 跨节点 TP 引擎选择及模型组配置、预检、创建、状态与清理。此版本已验证管理流程和 Kubernetes 清单，尚未通过真实 GPU 推理验收。硬件前提、操作方法及限制见 [分布式推理说明](docs/DISTRIBUTED.md)。

## PD 分离与场景参数

分布式推理页面支持实验性 vLLM + NIXL PD 分离，提供均衡对话、长输入、长输出三种调优起点，支持参数调整、P/D 拓扑与资源汇总、策略与配额预检、创建和清理。预设不是硬件最优认证；真实 KV 传输与性能仍待 GPU 验收。操作和限制见 [PD 部署说明](docs/PD.md)。



## 通知、排队与升级恢复

- “监控告警 → 外部告警通知”：配置 Webhook，启用后发送告警触发和恢复事件。管理员须先设置 `MINISTATION_WEBHOOK_HOSTS`。
- “平台设置 → 网关请求排队”：配置项目在途上限、等待容量和最长等待时间，默认关闭。
- “平台设置 → 升级与恢复演练”：查看数据库结构版本和隔离演练命令。

配置方法、签名协议、重试与升级边界见 [通知、排队与恢复指南](docs/DELIVERY.md)。

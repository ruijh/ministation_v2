# MiniStation v2

面向私有化模型部署与调用的轻量级推理平台（自托管推理网关 + LLM 引擎管理器），当前为开发验证版。代码、测试、容器配置与交付文档均保存在本目录。

**当前为开发验证版。** 功能边界见 [功能覆盖与交付范围](docs/COVERAGE.md)。

## 功能一览

- **统一网关**：OpenAI 兼容 `/v1/chat/completions`、`/v1/embeddings`、`/v1/models`、`/v1/decisions`；API Key 授权与撤销、SSE、预估 TPM/预算、用量计费、项目与角色隔离。
- **本机部署（无需 Kubernetes）**：直接在宿主机管理 llama.cpp / vLLM / 自定义引擎；已导入模型版本选择、GPU 缺省与显存/GPU 数校验、实时启动控制台、失败原因自动摘取、诊断包下载、一键接入发布。
- **集群部署**：Kubernetes 服务部署向导（vLLM / SGLang）、部署模板、容量与策略预检、接入发布、灰度与回退、弹性伸缩、原生资源、实验性分布式 TP / PD。
- **模型资产**：本机模型扫描、导入为“已导入模型版本”、删除（引用保护）、ModelScope 清单与流式下载。
- **运维**：用量账本与 CSV、监控告警（Webhook）、在线备份与恢复、结构升级演练、网关请求排队、环境初始化向导。

## 文档索引

| 文档 | 说明 |
| --- | --- |
| [API 与运行边界](docs/API.md) | 管理 / 调用 API、本机部署与模型资产接口、环境变量 |
| [部署与调用指南](docs/DEPLOYMENT-GUIDE.md) | 引擎向导、接入发布、诊断建议、本机部署 |
| [功能覆盖与交付范围](docs/COVERAGE.md) | 功能覆盖与验证范围 |
| [验证记录](docs/VALIDATION.md) | 自动化测试与真实环境验证记录 |
| [运行管理说明](docs/OPERATIONS.md) | 资源治理、监控告警、发布保护、弹性伸缩 |
| [通知、排队与恢复指南](docs/DELIVERY.md) | Webhook 告警、请求队列与升级恢复 |
| [决策服务](docs/DECISIONS.md) | JEV-CPU 结构化决策协议与部署 |
| [分布式推理](docs/DISTRIBUTED.md) / [PD 分离](docs/PD.md) | 实验性跨节点 TP 与 PD 分离 |
| [本地开发候选](docs/LOCAL-DEVELOPMENT.md) | 可推进的待开发功能 |

## 本机启动（Linux / 宿主直跑）

以下命令均在 MiniStation 项目根目录执行。要求 Node.js 24+（见 `package.json` engines）。

```bash
npm ci
npm run build            # 构建前端静态资源到 dist/
bash scripts/start.sh    # 启动控制面，监听 127.0.0.1:8787（Ctrl+C 停止）
bash scripts/stop.sh     # 配套停止
```

启动后访问 <http://127.0.0.1:8787>。`scripts/start.sh` 会顺带完成：识别 CUDA 工具链并补 `PATH` / `LD_LIBRARY_PATH`、查找 ninja、让 vLLM 使用 `.venv-vllm`、自动探测当前可见 GPU 并导出 `CUDA_VISIBLE_DEVICES`（可见即用，可用 `MINISTATION_CUDA_DEVICES=0,1` 覆盖）、设置模型扫描根目录 `MINISTATION_MODEL_SCAN_ROOTS`（默认 `/home` 与项目内 `artifacts/models`，均可覆盖）。

首次访问由用户设置管理员账号，不内置固定密码。默认项目使用 `ministation-workloads` 命名空间、4 核 / 8 GiB 配额，GPU 配额为 0。界面不预置虚假的服务和用量。

默认放行 `api.minimaxi.com`、`127.0.0.1`、`localhost` 三个上游主机，其他主机需管理员调整 `MINISTATION_UPSTREAM_HOSTS`；非回环监听需设置 `MINISTATION_BOOTSTRAP_TOKEN`。上游凭据 AES-256-GCM 加密保存，平台 Key 只保存哈希；不要删除 `data/master.key`。端口被占用、模型不存在或 GPU 数量 / 显存不满足时会在提交前或启动时给出明确错误。

（Windows/WSL 开发入口仍可用：先 `powershell -File .\infra\wsl\Start-Cluster.ps1` 恢复 Kubernetes，再 `powershell -File .\scripts\start-local.ps1`。）

## 接入 MiniMax

1. 在“接入服务”选择“接入模型服务”。已预填 Base URL `https://api.minimaxi.com/v1`、模型 `MiniMax-M3`。
2. 在本地输入上游 API Key、确认实际费率后保存。Key 不需要发到聊天里。
3. 执行连接测试，成功后发布逻辑模型，例如 `minimax-m3`。测试会调用上游。
4. 在“访问密钥”创建仅授权此模型的平台 Key，立即保存一次性显示的密钥。
5. 在“在线调试”输入平台 Key 并调用；在“用量账本”检查结果。

统一入口为 `/v1/chat/completions`、`/v1/embeddings`、`/v1/models`。使用 `Authorization: Bearer <平台 Key>`。不要将上游 Key 当作平台 Key。

## 本机部署（单机模式，无需 Kubernetes）

MiniStation 可直接在控制面宿主机上启动并管理一个 OpenAI 兼容推理引擎进程（llama.cpp / vLLM / 自定义命令），支持 CPU 与 GPU（GPU 需本机驱动）。入口在“服务部署 → 本机部署 → 新建部署”。

1. **选择已导入版本**：模型选择下拉只列出「模型资产 → 已导入模型版本」（先在“本机模型扫描”里点“导入资产”，或手动导入版本）；未导入的扫描模型不会出现在下拉中。选中版本会自动带出“对外模型名”（模型 basename，这是需要修改的主要字段），并可按类型推荐引擎（GGUF→llama.cpp、HF→vLLM）。
2. 填写对外模型名、监听端口。“GPU 数量”缺省为本机能力检测到的卡数；引擎下拉被手动改过后，选模型不再自动覆盖你的选择。
3. 端口占用、模型不存在、GPU 数量超过本机可见卡数、模型体积超过本机显存容量，都会在提交前或启动时给出明确错误；引擎与模型类型不匹配（如 GGUF 配 vLLM）也会被拦截并提示。
4. 可点“应用推荐参数”按模型体积与本机内存 / GPU 自动填充线程、上下文与 TP，并显示推荐理由。
5. 启动后，部署行的“启动 / 运行控制台”可展开实时查看引擎日志、状态与健康度。进程失败时，状态会直接显示真实原因摘取（如“进程退出 代码 1：CUDA OOM”或“World size (2) 大于可用 GPU (1)”），不用再翻日志猜原因。
6. 启动失败时点“分析”可下载诊断包 `ministation-diagnose-<id8>.zip`，内含完整引擎日志、部署参数、宿主机环境（nvidia-smi / 内存 / 磁盘 / 命令）与模型信息，便于离线排查。
7. 健康检查通过后点“接入与发布”：Base URL 自动填为 `http://127.0.0.1:<端口>/v1`，连接测试与发布会话和集群部署一致。

说明：

- 引擎仅监听本机回环地址，对外安全与授权由统一网关负责；默认上游白名单已放行 `127.0.0.1` / `localhost`。
- 本机部署是单实例单进程，不具备副本、自愈和多节点能力；停止 / 启动 / 删除、实时日志与诊断均可在界面操作，控制面退出时会向引擎发送终止信号并记录退出原因。
- 引擎二进制、模型权重和（GPU 场景）驱动需预先在本机就绪；不提供容器隔离。本机部署与集群部署可并存。
- 首次在本机跑通前，可打开「平台设置 → 环境初始化」：页面会检测 GPU / CUDA 工具链 / ninja / Python 头文件 / `.venv-vllm`，并按「下载 → 安装 → 部署 → 配置 → 验证」以动态 Console 逐行推流执行环境初始化，省去手工逐条命令。

## 本机 GPU 推理

宿主机物理带 **2× NVIDIA L20（48GB，Ada sm_90，PCIe `10de:26ba`）**。安装脚本见 `scripts/setup-gpu-driver.sh`（管理员在宿主机 root 下执行）。`bash scripts/start.sh` 启动时会**自动读取当前可见 GPU 并导出 `CUDA_VISIBLE_DEVICES`**（日志打印“GPU 可见性: 自动识别 N 卡 → …”，可见即用），因此 vLLM 可按可见卡数配置 TP。若控制面只检测到少于物理卡数（如只见 1 张）说明该 shell 环境对第 2 张不可见，可尝试 `MINISTATION_CUDA_DEVICES=0,1 bash scripts/start.sh` 或先排查 `nvidia-smi -L`；模型体积超过可见显存时，「本机部署」会在提交前拦截并提示改用更大 GPU 数、GGUF 量化版或 CPU。

两种 GPU 推理引擎（建议按模型选择）：

1. **CUDA 版 llama.cpp**（GGUF）：已编译在 `artifacts/llama.cpp/build-cuda/bin/llama-server`（sm_90）。部署时把“GPU 数量”设为 1-2，MiniStation 会自动追加 `-ngl 999` 将全部层卸载到 GPU；多卡由 llama.cpp 内部分配。
2. **vLLM**（HF 模型目录，适合 MoE / 大模型）：在宿主机运行 `bash scripts/setup-vllm.sh` 一键安装到 `.venv-vllm`（约 4GB 下载，自动尝试国内镜像）。优先级：显式 `MINISTATION_LOCAL_VLLM_BIN` > `.venv-vllm` > 系统 `python3`。部署时“GPU 数量”填 N 会自动加 `--tensor-parallel-size N`；`--trust-remote-code` 自动追加。
   - 提示：`vllm.entrypoints.openai.api_server` 在新版 vLLM 中已标记 Deprecated，建议把 `MINISTATION_LOCAL_VLLM_BIN` 改为 `.venv-vllm/bin/vllm serve` 形态。

检查命令（宿主机 shell）：`nvidia-smi -L` 应列出物理 GPU；实际可用数以控制面“本机能力”显示为准。

## 轻量工作台

主导航为运行总览、模型资产、服务部署、在线调试、监控告警和平台设置。相关页面在各入口内切换，分布式、灰度、策略和原生资源等高级功能按需展开。

大模型向导先检测目标集群与项目可用资源，再给出保守单卡配置；无 GPU 或无法检测时明确提示，不自动提高配额。已有模板提供容量与策略适配提示，镜像和模型硬件兼容性仍需验证。服务详情集中状态、日志、诊断与接入发布。详见 [部署与调用指南](docs/DEPLOYMENT-GUIDE.md)。

模型资产页提供本机扫描与魔搭下载：
- 可添加多个模型目录，只识别一级子模型（HF `config.json`+权重，或 `.gguf`）。扫描目录显示在“本机模型扫描”表里。
- 每个扫描到的模型支持批注描述、一键“导入资产”成为**已导入模型版本**；“已导入模型版本”可选中、可删除（仍被部署引用时后端拒绝并提示先解除关联）。
- 「本机部署」的“已导入版本”下拉只列已导入模型版本；从模板 / 编辑预填的未导入路径会以“已选，未在导入列表”保留可选。
- 「ModelScope 清单」拉取常见开源模型，按当前服务器资源自动筛选：不适配的模型不提供下载入口；下载目录可配置（缺省 `Models/`），下载器装入独立 `.venv-ms`，不污染 `.venv-vllm`。

部署模板页：
- **参数化**：模板 spec 可含 `{{变量}}`，使用时填值生成配置（缺参/未声明参数会在服务端拦截）。
- **管理**：编辑（名称/说明/参数/置顶）、删除、使用次数统计；从已就绪服务保存仍保留镜像摘要与来源修订。
- **共享**：导出 YAML（RESTful 模板文件）/ 导入，可跨项目复制；重名自动加后缀。
- **内置模板**：预置本机（llama.cpp/vLLM/自定义，与“环境初始化”联动）与集群（vLLM 大模型、llama-server、镜像部署、AI 服务）常用配方，支持“复制到项目”或直接使用。

## 已实现功能

- 管理员初始化、登录、改密、用户创建、项目隔离和管理员/开发者/只读角色。
- 模型外部引用、本地目录不可变快照、文件清单与 SHA-256。
- vLLM / SGLang 大模型部署向导；自动生成启动参数，校验 TP/GPU、模型卷、节点容量和项目策略；保留镜像与 AI 手动部署入口。
- 本机单机部署：无需 Kubernetes，直接在宿主机启动并管理 llama.cpp / vLLM / 自定义引擎；已导入版本选择与对外模型名、GPU 数量缺省本机卡数、GPU 数量/显存提交前校验、行内实时启动控制台、失败原因自动摘取（如 CUDA OOM、“World size 大于可用 GPU”）、诊断包下载（`ministation-diagnose-*.zip`），并支持一键“接入与发布”到统一网关。
- 本机模型扫描、导入与删除：`MINISTATION_MODEL_SCAN_ROOTS`（`scripts/start.sh` 默认 `/home` 与项目内 `artifacts/models`）下列出 HF 目录与 GGUF，支持描述、导入为模型版本、删除未引用版本；本机部署向导实时显示 llama.cpp / vLLM 就绪状态与选用建议。
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

要求 Node.js 24+，安装依赖执行 `npm ci`。

```bash
# 在 MiniStation 项目根目录执行
npm run check
npm test              # 单元与 API 测试
npm run build
```

Windows 下用 `npm.cmd` 等价命令；浏览器测试与集群验收：

```powershell
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

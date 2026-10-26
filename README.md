# MiniStation v2

面向私有化模型部署与调用的轻量级推理平台（自托管推理网关 + LLM 引擎管理器）。当前为开发验证版，功能边界见 [功能覆盖与交付范围](docs/COVERAGE.md)。

## 功能一览

- **统一网关**：OpenAI 兼容 `/v1/chat/completions`、`/v1/embeddings`、`/v1/models`、`/v1/decisions`；API Key 授权、撤销、恢复与删除，SSE、预估 TPM/预算、用量计费、项目与角色隔离。
- **本机部署**：无需 Kubernetes，在宿主机管理 llama.cpp / vLLM / 自定义引擎；支持已导入模型版本选择、GPU 与显存校验、实时启动控制台、失败原因摘取、诊断包下载和一键接入发布。
- **集群部署**：Kubernetes 服务部署向导（vLLM / SGLang）、部署模板、容量与策略预检、接入发布、灰度与回退、弹性伸缩、原生资源、实验性分布式 TP / PD。
- **模型资产**：本机模型扫描、导入为“已导入模型版本”、删除引用保护、ModelScope 清单与流式下载。
- **运维**：用量账本与 CSV、监控告警（Webhook）、在线备份与恢复、结构升级演练、网关请求排队、环境初始化向导。

## 文档索引

| 文档 | 说明 |
| --- | --- |
| [API 与运行边界](docs/API.md) | 管理 / 调用 API、本机部署与模型资产接口、环境变量 |
| [部署与调用指南](docs/DEPLOYMENT-GUIDE.md) | 引擎向导、接入发布、GPU 配置、诊断建议、本机部署 |
| [功能覆盖与交付范围](docs/COVERAGE.md) | 功能覆盖与验证范围 |
| [验证记录](docs/VALIDATION.md) | 自动化测试与真实环境验证记录 |
| [运行管理说明](docs/OPERATIONS.md) | 资源治理、监控告警、发布保护、弹性伸缩 |
| [通知、排队与恢复指南](docs/DELIVERY.md) | Webhook 告警、请求队列与升级恢复 |
| [决策服务](docs/DECISIONS.md) | JEV-CPU 结构化决策协议与部署 |
| [分布式推理](docs/DISTRIBUTED.md) / [PD 分离](docs/PD.md) | 实验性跨节点 TP 与 PD 分离 |
| [本地开发候选](docs/LOCAL-DEVELOPMENT.md) | 可推进的待开发功能 |

## 本机启动（Linux / 宿主直跑）

以下命令均在项目根目录执行。要求 Node.js 24+（见 `package.json` engines）。

```bash
npm ci
npm run build                  # 构建前端静态资源到 dist/
bash scripts/setup-vllm.sh     # 默认路径：vLLM 装进 .venv-vllm（HF/MoE 本机 GPU 部署前必做；仅 GGUF/CPU 可跳过）
bash scripts/start.sh          # 启动控制面，监听 127.0.0.1:8787（Ctrl+C 停止）
bash scripts/stop.sh           # 配套停止
```

> **默认推荐路径**：本机 GPU 部署 vLLM（HF / MoE 大模型）前，先执行 `scripts/setup-vllm.sh`。它会装入 `.venv-vllm`，自动尝试国内镜像；装好后 `start.sh` 会自动启用 vLLM。若只跑 GGUF（llama.cpp）、CPU 或自定义引擎，可跳过这一步。GPU 宿主机首次部署前，还需要管理员在 root 下执行 `sudo bash scripts/setup-gpu-driver.sh`。

启动后访问 <http://127.0.0.1:8787>。`scripts/start.sh` 会识别 CUDA 工具链、探测当前可见 GPU、导出 `CUDA_VISIBLE_DEVICES`，并设置模型扫描根目录 `MINISTATION_MODEL_SCAN_ROOTS`（默认 `/home` 与项目内 `artifacts/models`）。可用 `MINISTATION_CUDA_DEVICES=0,1` 覆盖 GPU 选择。

首次访问由用户设置管理员账号，不内置固定密码。默认项目使用 `ministation-workloads` 命名空间、4 核 / 8 GiB 配额，GPU 配额为 0。界面不预置虚假的服务和用量。

默认放行 `api.minimaxi.com`、`127.0.0.1`、`localhost` 三个上游主机，其他主机需管理员调整 `MINISTATION_UPSTREAM_HOSTS`；非回环监听需设置 `MINISTATION_BOOTSTRAP_TOKEN`。上游凭据 AES-256-GCM 加密保存，平台 Key 只保存哈希；不要删除 `data/master.key`。端口被占用、模型不存在或 GPU 数量 / 显存不满足时会在提交前或启动时给出明确错误。

## 接入 MiniMax

1. 在“接入服务”选择“接入模型服务”。已预填 Base URL `https://api.minimaxi.com/v1`、模型 `MiniMax-M3`。
2. 在本地输入上游 API Key、确认实际费率后保存。Key 不需要发到聊天里。
3. 执行连接测试，成功后发布逻辑模型，例如 `minimax-m3`。测试会调用上游。
4. 在“服务部署 → 访问密钥”创建仅授权此模型的平台 Key，之后可在列表中复制新创建的密钥；撤销后未过期密钥可恢复，也可在待核对用量核对完成后删除。
5. 在“在线调试”输入平台 Key 并调用；在“用量账本”检查结果。

统一入口为 `/v1/chat/completions`、`/v1/embeddings`、`/v1/models`。使用 `Authorization: Bearer <平台 Key>`。不要将上游 Key 当作平台 Key。

## 本机部署

MiniStation 可直接在控制面宿主机上启动并管理一个 OpenAI 兼容推理引擎进程（llama.cpp / vLLM / 自定义命令），支持 CPU 与 GPU。入口在“服务部署 → 本机部署 → 新建部署”。

1. 在“模型资产 → 本机模型扫描”选择模型并“导入资产”；未导入的扫描模型不会出现在本机部署下拉中。
2. 选中版本会自动带出“对外模型名”，并按模型类型推荐引擎：HF / MoE 模型默认走 vLLM，GGUF 走 llama.cpp。
3. 按需调整监听端口、GPU 数量和推理参数；端口占用、模型不存在、GPU 数量超过可见卡数、模型体积超过显存、引擎与模型类型不匹配都会被明确拦截。
4. 启动后使用“控制台”查看实时日志和健康度；失败时点“分析”下载诊断包。
5. 健康检查通过后点“接入与发布”，Base URL 自动填为 `http://127.0.0.1:<端口>/v1`。

本机部署是单实例单进程，不具备副本、自愈和多节点能力；引擎仅监听本机回环地址，对外安全与授权由统一网关负责。引擎二进制、模型权重和 GPU 驱动需预先在本机就绪；本机部署不提供容器隔离，但可与集群部署并存。

本机 GPU 引擎选择、vLLM 安装优先级、GPU 可见性排查和日志诊断边界见 [部署与调用指南](docs/DEPLOYMENT-GUIDE.md)。

## 测试

要求 Node.js 24+。先安装依赖，再运行质量检查：

```bash
npm ci
npm run check
```

`check` 会检查 JavaScript 语法、构建前端并执行单元与 API 测试。浏览器测试可单独运行：

```bash
npm run test:e2e
```

测试使用独立数据库或合成协议响应，不访问用户控制台数据；自动化测试通过不代表真实 GPU、模型下载或 Kubernetes 部署已经验收。集群验收命令与记录见 [验证记录](docs/VALIDATION.md)。

## 备份与恢复

```bash
npm run backup
# 停止应用后，将备份恢复到一个不存在的新目录
node scripts/backup.mjs restore data/backups/<时间目录> data-restored
# 然后通过 MINISTATION_DATA_DIR 指向恢复目录启动
```

备份使用 SQLite 在线备份 API，包含匹配的 `master.key` 与已登记模型快照，生成校验清单。恢复检查哈希与数据库完整性，禁止覆盖已有目录。备份不包含 Kubernetes 持久卷、外部模型仓库或上游供应商数据，应单独备份。

## 容器交付

根目录 Dockerfile 提供 Linux 镜像构建入口。首次构建需要访问 npm 和基础镜像仓库；容器镜像构建与完整断网安装尚未验收。运行时必须挂载持久 `/data`，并设置 `MINISTATION_BOOTSTRAP_TOKEN` 才能绑定非回环地址。Kubernetes Token / CA 使用只读文件挂载，并通过环境变量指定。企业暴露服务前应配置 HTTPS 反向代理；当前本机入口仅监听 127.0.0.1。

## 许可证

MiniStation 使用 [MIT License](LICENSE)。第三方代码与模型保留各自的许可证；参见 `examples/jev-cpu/vendor/LICENSE`、`examples/jev-cpu/vendor/THIRD_PARTY.md` 和 `examples/jev-cpu/provenance.json`。模型权重不随源码分发。

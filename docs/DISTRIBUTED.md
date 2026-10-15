# 分布式推理：SGLang / vLLM TP 实验版

MiniStation 支持创建一个跨 2–8 个 Kubernetes 节点的 SGLang 或 vLLM 张量并行（TP）模型组。每个节点运行一个协调进程并申请相同数量的 NVIDIA GPU；总 TP 度数为节点数乘以每节点 GPU 数。它不是多个互不通信的模型副本。

**当前交付的是实验性部署编排能力。已验证协议、管理流程和 Kubernetes 清单合法性，尚未在真实 GPU 上完成模型加载、推理结果与性能验收。**

## 研究依据与设计取舍

研究参考 GPUStack 的公开实现，检查的本地源码版本为 `e8924525eaf558284594eae440508a1ed1f9d524`：

- [SGLang 后端](https://github.com/gpustack/gpustack/blob/e8924525eaf558284594eae440508a1ed1f9d524/gpustack/worker/backends/sglang.py)：研究主从节点的 rank、节点总数和通信地址生成方式。
- [SGLang 资源选择器](https://github.com/gpustack/gpustack/blob/e8924525eaf558284594eae440508a1ed1f9d524/gpustack/policies/candidate_selectors/sglang_resource_fit_selector.py)：研究并行拓扑与设备分配约束。
- [SGLang 多节点说明](https://docs.sglang.ai/references/multi_node_deployment/multi_node.html)：核对 `--tp-size`、`--nnodes`、`--node-rank`、`--dist-init-addr` 等引擎参数的职责。

本实现没有复制第三方源码。GPUStack 采用自身 Worker 与调度管理体系；MiniStation 本轮使用 Kubernetes 原生 Deployment 和 Service，并沿用项目配额、策略及审计。vLLM 采用原生多节点 Multiprocessing（MP）执行器。暂不引入 Ray、流水线并行（PP）、数据并行（DP）或预填充/解码分离（PD）。

| 设计项 | 首版实现 | 边界 |
| --- | --- | --- |
| 节点选择 | 管理员明确指定节点，检查 Ready、禁止调度、污点、节点标签和剩余申请容量 | 不提供自动最优选点或拓扑性能评估 |
| 资源分配 | 全组 CPU、内存和 GPU 总量纳入项目配额；每个成员单独声明 requests/limits | 容量预检不是原子资源预留；没有 gang scheduler |
| 模型存储 | 所有成员挂载同一已绑定共享 PVC，并使用相同模型路径 | 需 ROX 或 RWX；不会创建、下载或删除模型卷 |
| 多节点启动 | 每个 rank 一个固定节点上的 Deployment，使用 Recreate 策略 | 不提供组内滚动升级；变更拓扑需新建模型组 |
| 通信发现 | 独立 Headless Service 指向 rank 0，并发布未就绪地址，避免初始化等待 DNS 就绪 | CNI、网络策略和引擎需支持 Pod 间通信；未调优 RDMA |
| 服务入口 | 普通 ClusterIP Service 仅指向 rank 0 | Windows 控制台通常需要管理员端口转发；不自动暴露公网 |
| 就绪检查 | 主节点 HTTP 健康检查；从节点进程运行且能访问主节点健康接口；聚合所有 Deployment 状态 | 管理就绪不是生成质量验证；仍需真实模型连接测试 |
| 故障处理 | 观察器约每 15 秒刷新；未就绪时关联后端需重新验证，网关拒绝新调用 | 不保证正在执行的请求不断流；不自动重启整个模型组 |
| 清理 | 关联发布引用、在途请求保护；按资源 UID 删除，确认资源消失后释放配额 | 删除中可点击继续清理；响应不确定或 UID 变化需人工核对 |

## 引擎适配器

引擎差异位于 `server/engines/`。注册表提供支持的引擎与公开元数据，每个适配器实现 `topology(spec)` 和 `member(spec, {rank, address})`，分别返回并行拓扑及容器命令、参数、环境变量、启动/就绪探针。共享编排层负责 Kubernetes 资源、项目策略、配额、UID、观测和清理，不再包含具体引擎的启动分支。

| 配置 | SGLang | vLLM |
| --- | --- | --- |
| API 引擎值 | `sglang`（默认） | `vllm` |
| 启动入口 | `python3 -m sglang.launch_server` | `vllm serve <model_path>` |
| 执行器 | SGLang 原生多节点 | 显式 `--distributed-executor-backend mp` |
| TP | `--tp-size`，全组 GPU 总数 | `--tensor-parallel-size`，全组 GPU 总数 |
| PP / DP | 本版不开放 | 固定 `--pipeline-parallel-size 1`、`--data-parallel-size 1` |
| 节点角色 | `--nnodes`、`--node-rank` | `--nnodes`、`--node-rank`；从节点附加 `--headless` |
| 初始化通信 | `--dist-init-addr <主节点DNS>:20000` | `--master-addr <主节点DNS> --master-port 29501` |
| API 入口 | rank 0，8000 端口 | rank 0，8000 端口；从节点不启动 API |
| 节点地址 | 引擎原生发现 | 通过受控 Downward API 将实际 Pod IP 写入 `VLLM_HOST_IP` |

vLLM 的参数及 headless 行为已按官方 [v0.31.0 CLI 源码](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/entrypoints/cli/serve.py)和[并行配置源码](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/config/parallel.py)核对。这是接口参考版本，不是 GPU 镜像认证；镜像摘要不会自动证明其内部 vLLM 版本。使用其他版本前，应确认具有这些 MP/headless 参数。旧版仅支持 Ray 多节点的镜像不能使用本适配器。

两种引擎均由适配器配置健康检查。vLLM headless 从节点不接受本地 HTTP 检查，改为在进程存活的前提下检查主节点健康接口；该检查不证明每个 GPU rank 的计算正确性。不同引擎的初始化端口由元数据驱动，但还需要 Pod 间动态通信端口可达，不能仅放通 20000 或 29501。

省略 `engine` 的历史输入仍默认为 SGLang，已保存模型组的清单不会自动重写；未知引擎会在创建前被拒绝。引擎和拓扑不可原地修改，需要新建组。公开引擎目录来自 `GET /api/distributed/engines`，网页选择器使用同一份数据。

## 使用前提

1. 至少两个节点，每节点有相同数量的可分配 NVIDIA GPU。GPU 型号、显存、驱动、CUDA 与所选引擎镜像需兼容，模型 attention heads 等还需满足 TP 约束。当前预检不验证这些模型内部条件。
2. 模型文件位于项目命名空间下已绑定的 `ReadOnlyMany` 或 `ReadWriteMany` PVC。各节点看到的路径与内容相同。容器离线加载模型，不允许通过表单执行任意远程代码。
3. 镜像必须使用真实 SHA-256 摘要，包含 Python 3 及所选引擎启动入口，并允许 UID 1000 非 root 运行。没有预置一个声称已完成硬件认证的镜像摘要。
4. 节点需能通过 Pod 网络互通、解析集群 DNS；通信不仅使用初始化端口（SGLang 为 20000，vLLM 为 29501），NCCL 还需要节点间通信。此版本不自动使用 hostNetwork、特权容器、RDMA 设备或网络放通规则。
5. 控制器需有现有 RBAC 中的节点、全局 Pod、命名空间 PVC 读取，以及 Deployment、Service 的预检、创建、读取、删除权限。
6. 项目配额、资源池、镜像允许列表和标签规则必须允许整个模型组。可通过现有项目 API 创建具有足够 GPU 配额的项目；默认项目 GPU 配额为 0。

## 网页操作

左侧“工作空间 → 分布式推理”：

1. 点击“配置模型组”，选择 SGLang 或 vLLM，填写节点名称、每节点资源、对应引擎镜像摘要、模型 PVC 与目录、服务模型名。
2. 点击“运行分布式预检”。只有策略、容量、共享卷及 Kubernetes 服务端预检通过，才显示创建按钮。
3. 查看总资源与清单后点击“创建分布式模型组”。创建会重新检查，不依赖之前的预检结果。
4. 使用“同步状态”或等待后台观测，查看成员是否就绪。“需要处理”时查看详情中的错误，不反复创建同名组。
5. 在“接入服务”中填写可达的 Base URL、模型名和“关联分布式模型组 ID”，完成真实连接测试，再发布逻辑模型。
6. 下线时先在“发布管理”排空相关路由，再删除模型组。删除只清理计算与服务资源，保留模型 PVC。

数据库记录会保留已删除组的历史与名称。重新部署使用新的模型组名称。

## API

所有接口需要会话与项目权限；写操作需要 `X-Ministation-Client: console`。除同步状态允许开发者使用外，创建、预检与删除仅管理员可用；只读角色可以查看列表。

| 接口 | 方法 | 用途 |
| --- | --- | --- |
| `/api/distributed/engines` | GET | 返回引擎标识、显示名称、模式、端口及镜像要求 |
| `/api/distributed` | GET | 当前项目的模型组及最近观测状态 |
| `/api/distributed/preview` | POST | 完整预检、总资源、清单与限制说明，不保存模型组 |
| `/api/distributed` | POST | 保存配额占用并创建资源，返回模型组记录 |
| `/api/distributed/:id/refresh` | POST | 核对资源 UID 与所有成员状态 |
| `/api/distributed/:id/delete` | POST | 删除或继续清理模型组 |

请求示例（必须替换镜像摘要、节点和 PVC）：

```json
{
  "name": "sglang-tp-demo",
  "engine": "sglang",
  "image": "registry.example/sglang@sha256:<真实镜像摘要>",
  "nodes": ["gpu-node-a", "gpu-node-b"],
  "gpus_per_node": 1,
  "cpu": 4,
  "memory_gib": 16,
  "model_pvc": "shared-models",
  "model_path": "/models/my-model",
  "served_model": "my-model",
  "labels": {}
}
```

`pool_id` 可选。使用 vLLM 时将 `engine` 改为 `vllm` 并提供对应 vLLM 镜像的真实摘要，其他资源字段不变。预检响应额外返回 `engine` 元数据和 `topology`（TP、PP、节点数、执行器）。自定义命令、任意引擎参数、零 GPU、重复节点、模型目录穿越均被拒绝。`POST /api/backends` 可带 `distributed_id` 关联就绪模型组，不能同时关联普通 `deployment_id`，创建后关联不可修改。

创建接口的 HTTP 201 表示管理记录已建立；必须继续查看 `status`。资源创建可能部分成功并返回 `NeedsAttention`。不会把 API 超时当作资源一定未创建，也不会自动删除无已知 UID 的同名资源。

## 验证与下一阶段

运行 `npm run check` 验证原有能力与新增集成测试，运行 `npm run test:e2e` 验证界面。配置 Kubernetes 凭据后运行 `node scripts/verify-distributed-cluster.mjs` 可执行只读服务端 dry-run：该脚本故意使用占位镜像和 PVC，只检验清单 API 合法性，不创建资源，也不执行推理。

2026-10-15 已通过本地集群对两种引擎合计 4 个 Service 和 4 个 Deployment 的 dry-run。集群可分配 GPU 数为 **0**，因此真实分布式推理仍未验收。结果写入不随源码发布的 `artifacts/distributed/admission.json`。

后续硬件验收需要固定镜像和模型版本，完成：两节点加载、各 rank GPU 使用证据、真实请求与输出核验、失败节点退出后的组状态与网关阻断、重新部署恢复、排空清理、吞吐与延迟测量。硬件验收通过前不宣称此路径可生产使用。PP、Ray 执行器、PD、gang scheduling、组级自动恢复与自动伸缩属于后续范围。

# API 与运行边界

## 管理 API

管理 API 位于 `/api`。登录使用 HttpOnly / SameSite=Strict 的会话 Cookie，有效期 8 小时；写入请求必须携带 `X-Ministation-Client: console`。管理员可通过 `X-Project-Id` 切换项目，其他角色只能操作自身项目。账号密码最少 12 字符；改密后所有旧会话失效。

| 路径 | 方法 | 行为 |
| --- | --- | --- |
| /auth/status, /auth/setup, /auth/login | GET / POST | 首次初始化与登录 |
| /auth/logout, /auth/password | POST | 注销、改密 |
| /me, /projects, /users, /settings | GET | 账号、项目、用户与配置 |
| /projects, /users | POST | 管理员创建项目/用户 |
| /models | GET / POST | 模型版本与本地快照 |
| /deployments/validate, /deployments | POST | 预检、创建草稿（支持 Idempotency-Key） |
| /deployments/:id/launch | POST | 返回 202 与后台任务，轮询 /operations/:id |
| /deployments/:id/manifest | GET | 生成 Kubernetes 清单 |
| /deployments/:id/refresh | POST | 同步实际代际与 readiness |
| /deployments/:id/revise | POST | `{spec,version}` 更新修订，version 为对象并发版本 |
| /deployments/:id/rollback | POST | `{revision,version}` 回到历史配置并产生新修订 |
| /deployments/:id/stop, /resume, /delete | POST | 停止、恢复、删除；恢复需要 version |
| /deployments/:id/diagnostics, /logs | GET | Pod、事件、最多 100 行日志；日志记录审计 |
| /backends, /flows, /routes | GET / POST | 服务接入、编排、发布 |
| /backends/:id/credential, /probe | POST | 更新凭据、真实探测 |
| /routes/:id/toggle | POST | `{enabled,version}` 上下线 |
| /flows/validate | POST | `{graph}` 校验已授权且验证通过的下游 |
| /native/validate, /native/apply | POST | `{yaml}` 服务端预检、创建 |
| /native/:id/rollback | POST | 仅删除本记录创建的 UID 匹配资源；不自动删除 PVC |
| /keys, /keys/:id/revoke | GET / POST | Key 创建、列表、撤销 |
| /usage, /usage/export, /audit, /operations | GET | 用量、CSV、审计与任务 |
| /usage/:id/reconcile | POST | 管理员提供 `{input,output,cost_micros,evidence}` 核对缺失计量 |
| /cluster, /cluster/nodes/:name/cordon | GET / POST | 节点与禁止/恢复新调度 |

请求 JSON 上限 1 MiB。错误采用 `{error:{code,message,details?,request_id}}`。计费数据不含请求正文与凭据。

## 调用 API

- `GET /v1/models`：返回此 Key 授权且已发布的逻辑模型。
- `POST /v1/chat/completions`：文本 messages，max_tokens 1–8192，单服务支持 SSE。上游流式协议必须返回 `[DONE]`；中断不透明续传。
- `POST /v1/decisions`：JEV-CPU 结构化决策，详见 [决策服务](DECISIONS.md)。
- `POST /v1/embeddings`：文本或文本数组，缺省 completion_tokens 视为 0。
- 流式请求自动要求上游提供 usage。若缺失或格式不合法，记为 pending，保留预算预占，不伪造零用量。
- 编排当前仅非流式，串行将前一节点的文本结果作为后一节点的 user 消息；融合输出分支结果 JSON；流量节点权重总和为 100；条件字段支持点路径、eq/contains/gte/lte，必须有唯一默认分支。

费用单位：服务费率为元 / 百万 Token，账本 cost_micros 为百万分之一元。输入已包含缓存命中 Token，计费时将缓存部分按 cache_rate 单独计算。融合/串行记录父请求与子调用，项目汇总只计算父请求，避免重复累计。

TPM 与预算使用保守估算预占，完成后以上游 usage 结算；不是特定模型 tokenizer 的精确预判，因此很小的请求可能也需要较高的预占额度。上游不遵守 max_tokens 时仍按实际 usage 记账，不能宣称硬性阻止供应商超额生成。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| HOST / PORT | 默认 127.0.0.1 / 8787 |
| MINISTATION_DATA_DIR | 默认 data，数据库、主密钥、模型快照 |
| MINISTATION_BOOTSTRAP_TOKEN | 非回环监听必须配置，首次初始化需要输入 |
| MINISTATION_SECURE_COOKIES | HTTPS 反向代理部署设为 true |
| MINISTATION_UPSTREAM_HOSTS | 逗号分隔精确主机白名单；不允许带凭据 URL 或重定向 |
| MINISTATION_MODEL_ROOT | 管理员可导入模型的本地根目录 |
| MINISTATION_KUBE_URL | HTTPS Kubernetes API |
| MINISTATION_KUBE_TOKEN_FILE / MINISTATION_KUBE_CA_FILE | Token 与 CA 文件路径，Token 每次请求重新读取 |
| HTTP_PROXY / HTTPS_PROXY / NO_PROXY | 上游网络代理；localhost 自动绕过 |

不支持同一数据库并行运行多个控制面实例。重启会将未完成请求转为待核对，将中断部署任务标为 Interrupted，相关部署进入 Reconciling 并由后台观测实际资源。不会盲目重放创建请求。
# 接入服务查看与编辑

`GET /api/backends/:id` 返回项目内服务详情，隐藏凭据，仅提供 has_credential 标记。

`POST /api/backends/:id/update` 仅管理员可用，提交完整可编辑配置及 version；过期版本返回 409。api_key 留空保留，非空加密替换。地址、模型、协议、超时或凭据变化使服务进入 Unverified，重新测试成功前网关拒绝新调用；名称、默认逻辑模型名和费率修改保留连接状态。已发布路由名称不随默认逻辑模型名修改。关联部署不在此接口调整。所有变更写入审计，历史请求费用不重算。


## 部署模板、健康观测与服务指标

- `GET /api/templates`：当前项目模板列表。只读角色也可查看。
- `POST /api/templates`：开发者及管理员从容器就绪部署保存模板，提交 name、description、deployment_id。保存不可变配置和来源修订，不自动追随后续修订。模板仅证明来源容器曾就绪，不代表模型精度或 GPU 认证。
- 使用模板时将其 spec 和新名称提交到原有 `POST /api/deployments`，仍需部署预检。模板包含项目内模型/PVC引用，删除或修改外部资源后需重新核对。
- `GET /api/deployments/:id/health`：最近观测、就绪条件和最近 200 条持久状态变化。观测仅读取 Kubernetes，不产生模型调用费用；后台默认每轮结束 15 秒后检查下一轮。
- `POST /api/deployments/:id/refresh`：手动触发同一观测逻辑。正在创建或修订中的对象由写操作完成后再观测，避免覆盖并发操作。
- `GET /api/metrics?hours=24`：1–168 小时窗口（默认 24）；按项目顶层账本请求统计请求量、失败率、P95 延迟、P95 首 Token、窗口内在途请求、逻辑模型和小时分桶。不含入账前的鉴权或配额拒绝；不重复计算子调用。无样本为 null；PROCESS_RESTARTED 单独计入未知，不混入失败率分母。

观测器负责状态同步、故障解释及重启后核对，不自动重放中断写操作或自动修复集群配置。Deployment/Service 存在且容器探针通过不等同于端到端模型调用健康。后续资源治理、发布与伸缩已补充资源指标、控制台告警及自动伸缩，详见下节。

## 资源治理、发布与伸缩接口

| 接口 | 权限与行为 |
| --- | --- |
| GET /api/pools | 当前项目资源池 |
| POST /api/pools | 管理员创建；name、description、selector |
| POST /api/pools/:id/delete | 管理员；有部署/模板/策略引用时拒绝 |
| GET /api/capacity | 管理员；配额、资源池匹配节点、全局 Pod requests 与剩余申请空间 |
| GET /api/policy | 当前项目策略 |
| POST /api/policy | 管理员；已有策略需 version；字段见 governance.mjs 的 policySchema |
| GET /api/monitoring | 项目采样、告警规则与状态、伸缩配置与状态 |
| POST /api/monitoring/sample | 管理员触发资源采样及告警评估 |
| POST /api/alerts | 管理员创建规则；字段见 runtime.mjs 的 alertSchema |
| POST /api/alerts/:id/toggle | 管理员；version、enabled |
| POST /api/alerts/:id/acknowledge | 非只读角色；id 为 alert_state ID，确认知晓不清除告警 |
| GET /api/releases | 当前项目路由发布状态及在途数 |
| POST /api/routes/:id/rollout | 非只读角色；version、candidate_id、candidate_percent、fallback_ids、failover_enabled、rollback_enabled、min_samples、window_seconds、max_error_rate、max_p95_ms |
| POST /api/routes/:id/promote | 非只读角色；version；提升已验证候选 |
| POST /api/routes/:id/rollback | 非只读角色；version；灰度撤回或回退上一次提升 |
| POST /api/routes/:id/drain | 非只读角色；version、timeout_seconds（1–60）；超时返回409并保留排空状态 |
| POST /api/routes/:id/cancel-drain | 非只读角色；version；解除新请求阻断 |
| GET /api/autoscaling | 当前项目伸缩策略及执行状态 |
| POST /api/autoscaling | 管理员；deployment_id、enabled、metric（cpu/concurrency）、target、min_replicas、max_replicas、cooldown_seconds、down_samples；更新需 version |

部署配置新增 pool_id、labels。默认资源仅填充缺失字段；原生 Pod 模板通过 annotation `ministation.io/pool-id` 指定资源池。后台采样和自动化只由正式 server/index.mjs 启动，createApp 测试实例不会自动写集群。

`MINISTATION_PROMETHEUS_URL` 为管理员启动时配置的内部 Prometheus 地址，不接收浏览器传入的任意监控 URL。后端使用固定 namespace/pod 查询；DCGM 必须提供 namespace/pod 标签。无数据返回 null。

自动化及发布行为的边界见 OPERATIONS.md；控制台告警不发送外部消息，缩容排空不覆盖绕过网关的直连请求。

## 实验性分布式模型组

新增 `/api/distributed` 列表与创建、`/api/distributed/preview` 预检、`/api/distributed/:id/refresh` 同步、`/api/distributed/:id/delete` 清理。模型组按项目隔离，创建与清理仅管理员可操作；`POST /api/backends` 可通过 `distributed_id` 关联就绪组。具体参数、部分失败语义与边界见 [分布式推理说明](DISTRIBUTED.md)。

分布式引擎目录：`GET /api/distributed/engines`。创建和预检请求接受 `engine: "sglang" | "vllm"`，省略时兼容默认 SGLang。vLLM 固定使用多节点 MP 执行器和全局 TP；预检返回引擎元数据及 `topology`。未知引擎返回 422，已有模型组不自动切换引擎。

## PD 模式

`GET /api/distributed/presets` 返回三个启发式场景预设；不表示硬件认证或性能最优。
`POST /api/distributed/preview` 与创建接口新增 `mode: "pd"`（省略默认 `tp`），要求 `engine: "vllm"`。通用节点、镜像、模型卷和资源字段沿用；额外 `pd` 对象示例：

```json
{"preset":"balanced","prefill_nodes":1,"router_image":"registry.example/node@sha256:<64位十六进制摘要>","max_model_len":8192,"prefill_batch":4096,"decode_batch":2048,"max_num_seqs":32,"gpu_memory_utilization":0.85,"timeout_seconds":120}
```

`nodes` 前 `prefill_nodes` 个为 P，其余为 D，必须各至少一个。每节点 GPU 数是每实例 TP，所有节点互不重复。PD 的 `total` 包含路由器额外 0.5 CPU / 0.5 GiB，`topology` 返回 P/D 数与 connector；`members` 含 role。TP 模式禁止 `pd` 参数，PD 禁止 SGLang、未知字段或无 Decode 的组合。所有原有项目、角色、策略、UID 清理与发布保护继续生效。详细限制见 [PD 说明](PD.md)。

## 告警通知与请求队列

- `GET /api/webhooks`：管理员读取当前项目渠道、最近 100 条投递记录、目标主机允许列表；不返回 URL 或签名密钥。
- `POST /api/webhooks`：管理员创建 `{name,url,signing_secret,enabled}`，默认禁用。签名密钥至少 16 字符，目标主机须在 `MINISTATION_WEBHOOK_HOSTS` 内。
- `POST /api/webhooks/:id/toggle`：管理员提交 `{version,enabled}`；禁用取消等待投递。
- `POST /api/webhooks/:id/test`：管理员向启用渠道排入测试事件，返回 202；不代表投递已成功。
- `GET /api/request-queue`：读取当前项目队列 policy/state。
- `POST /api/request-queue`：管理员提交 `{enabled,max_active,max_waiting,wait_seconds,version?}`；更新需版本，有在途或等待请求时返回 409。
- `GET /api/settings` 新增 `schema_version`。

投递语义、队列错误码和数据迁移说明见 [运维指南](DELIVERY.md)。

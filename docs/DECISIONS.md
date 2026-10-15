# CPU 决策模型

MiniStation 使用 JEV-CPU / SemIf 的选项 logits 读取方法，在 CPU 上运行 Qwen3-0.6B。它不是 TypeSafe 官方 Jev，也不是文章中的 Jev-intern/Jev-clef。推理不调用 generate，不输出生成式回答；选项概率未经过业务校准。

## 已实现

- 模型任务 `decision`、服务协议 `decision`（当前适配 JEV-CPU `/api/decide`）。
- 服务连接测试、发布、项目隔离、平台 Key、RPM/TPM/预算和用量账本。
- `POST /v1/decisions`：文本或 JSON 状态、1～8 个问题、每题 2～16 个候选选项。
- 在线调试中的“结构化决策”，展示答案、选项概率、延迟与真实输入 Token。
- 编排中的“决策路由”：保留原始对话输入，根据 `decisions.<问题ID>.winner` 等字段选择后续 Chat 服务。
- 低于阈值、模型不可用、上游错误、协议错误均走唯一默认分支；客户端取消和整个工作流超时不再执行回退。
- 决策服务部署、停止、修订等操作沿用现有 Kubernetes 生命周期和引用保护。

## 调用

在“接入服务”创建 JEV-CPU 决策协议，Base URL 为服务根地址，例如 `http://127.0.0.1:8801`，上游模型为 `Qwen/Qwen3-0.6B`。连接测试成功后发布 `jev-cpu-qwen3-0.6b`，在“访问密钥”创建只授权此模型的平台 Key。

```http
POST /v1/decisions
Authorization: Bearer <平台 Key>
Content-Type: application/json
```

```json
{
  "model": "jev-cpu-qwen3-0.6b",
  "state": "我的订单被重复扣款，请退回多扣的钱。",
  "criteria": [{
    "id": "route",
    "question": "应由哪个部门处理？",
    "options": [
      {"id": "billing", "description": "账单和退款"},
      {"id": "technical", "description": "技术故障"}
    ]
  }]
}
```

响应包含 `results[].winner`、`ranked[].{id,prob}`、`usage`、`latency_ms` 和请求 ID。禁止 `stream`、`max_tokens` 等聊天参数；不将自由生成文本伪装成结构化决策。

## 编排

决策路由节点包含 `backend_id`、`criteria`、`min_probability`、`children`。分支条件示例：

```json
{"field":"decisions.route.winner","op":"eq","value":"billing"}
```

概率字段为 `decisions.route.probability`。条件运算支持 `eq`、`contains`、`gte`、`lte`。唯一默认分支设置 `default:true`。节点 `min_probability` 为所有问题的最大选项概率下限；任一问题未达到阈值就回退。界面默认 0.8 仅为可编辑的示例，必须用独立业务样本选择实际阈值。

流程仍通过非流式 `/v1/chat/completions` 调用，最终分支返回 Chat 结果。决策结果只用于分支判定，不作为未知字段透传给聊天供应商。融合分支的上下文相互独立；当前不支持任意 DAG 数据映射。

## 计量边界

CPU 引擎逐题执行，每题统计真实 tokenizer 输入长度；重复状态随每次前向计算重复计入。输出 Token 为 0。没有完整输入计量时进入待核对，不补造 Token。上游失败可能已经消耗算力，因此保持不确定预占，遵循现有人工核对流程。服务流的父请求汇总子调用，页面总览不重复累加子账目。

本地部署默认 Token 费率为 0，表示未配置货币费率，不代表硬件、电力或运维成本为零。尚未支持按问题数计费、成本自动估算和概率校准。

## 下载、运行与部署

模型及推理代码 revision 见 `examples/jev-cpu/provenance.json`。上游许可证保存在 `vendor/LICENSE`、`vendor/THIRD_PARTY.md` 和下载模型的 `LICENSE`。

Windows 下载：

```powershell
powershell -ExecutionPolicy Bypass -File examples/jev-cpu/download-model.ps1
```

权重从 ModelScope 镜像分段获取，最终必须匹配固定 HF revision 对应的 SHA-256。也可使用 `download.py` 从 Hugging Face 获取固定版本。

WSL 使用独立 `/opt/ministation-jev-venv` 环境，安装 CPU torch 和 `requirements.txt`。本机离线构建复用已验证的 Python 3.12 基础镜像及该环境的 Linux 包：

```powershell
$scriptPath = (Resolve-Path './examples/jev-cpu/build-local.sh').Path
$wslScriptPath = (wsl -d MiniStation --exec wslpath -a $scriptPath).Trim()
wsl -d MiniStation -u root --exec bash "$wslScriptPath"
node scripts/deploy-jev-cpu.mjs
```

`deploy-jev-cpu.mjs` 是需要控制面数据目录访问权的本地管理员工具。先备份，再创建临时管理员会话，通过常规 API 的配额检查、部署、验证与发布。退出时删除会话并撤销验收 Key；不读取或重设管理员密码，不输出凭据。

默认部署申请 2 CPU、4 GiB 内存、0 GPU、1 副本。镜像内包含权重，推理运行时禁用网络下载。健康接口在模型加载完成后才可访问。单实例只允许一个计算请求，忙时返回 429，避免 CPU 请求无限排队；每题上限 1024 输入 Token，超长请求拒绝而非截断。

通用联网构建入口为 `examples/jev-cpu/Dockerfile`。`Dockerfile.offline` 是本机验证路径；通用构建需要另行验证基础镜像和依赖源可用性。

Windows 控制面通过本地 port-forward 访问 ClusterIP。部署脚本将转发脚本和服务名称文件安装到 `/opt/ministation/jev-forward`，并安装 ministation-jev-forward.service，由 WSL systemd 自动重试转发；重启后先恢复集群。以下命令在 MiniStation 项目根目录执行。需要手工检查转发时可运行（先停止同名 systemd 单元，避免端口冲突）：

```powershell
$scriptPath = (Resolve-Path './examples/jev-cpu/port-forward.sh').Path
$wslScriptPath = (wsl -d MiniStation --exec wslpath -a $scriptPath).Trim()
wsl -d MiniStation -u root --exec bash "$wslScriptPath"
```

## 验收

```powershell
npm.cmd run check
npm.cmd run test:e2e
node scripts/evaluate-decisions.mjs
```

真实部署及网关验收结果：`artifacts/jev-cpu/validation.json`。
中文功能评测：`artifacts/jev-cpu/evaluation.json`，使用预先固定标签的100条人工编写样本，覆盖5类工单。这是功能评测，不是独立基准或真实客户数据；不可将结果当成生产准确率。

第一版只支持离散选项；可以把等级定义为选项，但没有原生连续评分接口。小模型在复杂、多义、长文本任务上的效果需要单独验证。

详细效果及误分类分析见 [CPU 决策验收](CPU-DECISION-VALIDATION.md)。

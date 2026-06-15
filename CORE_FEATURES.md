# Codex API Pool - 核心功能点

本文档详细说明了 Codex API Pool 的核心功能和设计理念。

## 目录

1. [双客户端请求智能识别与协议匹配](#1-双客户端请求智能识别与协议匹配)
2. [多上游智能路由与负载均衡](#2-多上游智能路由与负载均衡)
3. [多协议支持与自动适配](#3-多协议支持与自动适配)
4. [智能容错与故障恢复](#4-智能容错与故障恢复)
5. [可用性与配额管理](#5-可用性与配额管理)
6. [账单信息管理](#6-账单信息管理)
7. [模型管理](#7-模型管理)
8. [多密钥支持](#8-多密钥支持)
9. [运行时管理能力](#9-运行时管理能力)
10. [安全与鉴权](#10-安全与鉴权)
11. [高级诊断功能](#11-高级诊断功能)
12. [Codex OAuth 支持](#12-codex-oauth-支持)
13. [高级管理特性](#13-高级管理特性)
14. [运维友好](#14-运维友好)
15. [测试与质量保证](#15-测试与质量保证)

---

## 1. 双客户端请求智能识别与协议匹配 ⭐

该项目支持**两个客户端同时使用**，通过识别请求类型自动选择对应的上游协议入口。

### 客户端请求识别

- **Codex Desktop** → 发送 `/v1/responses` 请求（OpenAI Responses API）
- **Claude CLI** → 发送 `/v1/messages` 请求（Anthropic Messages API）

### 智能协议匹配策略

- Pool 根据**接收到的请求类型**，自动选择上游的对应协议入口
- **Protocol Matching 优先于 weight**：优先路由到具有原生协议能力证据的上游（无损转发）
- 只有在没有原生协议上游可用时，才进行有损协议适配（需配置兼容模式）

### 请求路由示例

**Codex Desktop 路由**：
```
Codex Desktop 发送 Responses 请求
  ↓
Pool 识别为 Responses 协议
  ↓
优先选择已验证支持 /v1/responses 的上游（原生转发）
  ↓
如无可用 → 转换为 Chat Completions 或 Messages（有损兼容）
```

**Claude CLI 路由**：
```
Claude CLI 发送 Messages 请求
  ↓
Pool 识别为 Anthropic Messages 协议
  ↓
优先选择已验证支持 /v1/messages 的上游（原生转发）
  ↓
如无可用 → 转换为其他协议（有损兼容）
```

### 两层协议能力发现机制

由于上游商家返回信息格式不统一，协议能力确认分为两层：

#### 1. Health Probe 层（基础监测）

- 仅用于基础健康检查（可用性、延迟、模型列表发现）
- **不作为协议能力的权威判断**
- **不影响实际模型转发的协议选择和上游可用性**
- 仅作为 Dashboard 展示和诊断参考
- 可能的结果：`assumed`（基于配置声明）、`unknown`（未探测）

#### 2. 实际流量层（权威验证）⭐

- **真正的协议能力证据来自实际模型请求的调用结果**
- 当 Selection 选中某个上游后，根据具体的响应结果判断协议能力：
  - 成功响应（200 + 正常输出）→ 标记为 `verified`（该协议可用）
  - 404/405/501 或明确的端点不支持错误 → 标记为 `unsupported`（该协议不可用）
  - 其他错误（500/timeout）→ 保持原状态（非权威证据，可能是临时故障）
- Protocol Capability 证据优先级：`verified`（实际成功）> `unsupported`（实际失败）> `assumed`（配置声明）> `unknown`
- 上游可同时支持多种协议，每种协议能力独立验证

### 协议能力的状态转换

```
新上游添加
  ↓
根据 api 配置设置初始状态
  - api: "openai"     → Responses/Chat 为 assumed, Messages 为 unknown
  - api: "anthropic"  → Messages 为 assumed, Responses/Chat 为 unknown
  - api: "both"       → 所有协议为 assumed
  - 未配置            → 所有协议为 unknown
  ↓
第一次实际请求
  ↓
根据响应更新协议能力
  - 200 + 正常输出    → verified（权威证据，优先使用）
  - 404/405/501      → unsupported（权威证据，排除使用）
  - 其他错误          → 保持原状态（非权威，等待下次验证）
```

### Request Interface 学习

- 记录每个上游对特定模型成功使用的协议接口
- Forwarding Strategy：基于实际成功流量形成的转发策略
- Native Responses Recheck：定期重试原生路由，避免临时故障导致永久降级（默认 30 分钟）

### 配置声明作为初始假设

- `api: "openai"` → 初始假设支持 Responses/Chat Completions
- `api: "anthropic"` → 初始假设支持 Messages  
- `api: "both"` → 初始假设同时支持
- **实际流量的验证结果会覆盖配置声明**

---

## 2. 多上游智能路由与负载均衡

在 Codex Desktop/Claude CLI 和多个上游 API 服务之间提供统一代理入口，通过多维度评估选择最佳上游。

### Selection 流程

#### 第一阶段：基础过滤（排除明确不可用的上游）

- 排除 **Disabled Upstream**（用户手动停用）
- 排除 **Quarantined Upstream**（用户隔离的不稳定上游）
- 排除 **缺少 Upstream Key** 的（配置错误）
- 排除 **处于 Cooldown 的上游或 Key**（实际流量失败后的临时冷却）
- 排除 **Codex OAuth token 已过期** 的
- 排除 **与 Requested Model 或 Model Override 不匹配** 的（GPT 模型 vs Claude 模型）

#### 第二阶段：协议能力筛选 ⭐

在第一阶段过滤后的上游中，根据客户端请求类型筛选支持该协议的上游：

- 根据请求识别所需协议（Responses / Messages / Chat Completions）
- 筛选协议能力：
  - **优先：`verified` 状态**（实际流量验证成功，最可靠）
  - **其次：`assumed` 状态**（基于配置声明 `api: "openai"/"anthropic"/"both"`）
  - **尝试：`unknown` 状态**（未验证，可以尝试）
  - **排除：`unsupported` 状态**（实际流量验证失败，明确不支持）

**这一步筛选出的就是真实可用的候选上游池** ✅

#### 第三阶段：动态评分与概率选择

对候选上游计算 Selection 分数：

```
selection_score = weight × availability_multiplier × representative_success_multiplier
                  / (1 + in_flight + latency_penalty + health_penalty + failure_penalty)
```

**各维度说明**：

- **weight**：用户配置的基础权重，越高越容易被选中
- **availability_multiplier**：基于滚动窗口成功率的动态乘数
- **protocol matching**：协议能力优先参与候选池构建
  - 如果存在匹配入口协议的 `verified` 上游，Selection 会优先在这些上游中抽选
  - 没有 `verified` 证据时，继续允许 `assumed` / `unknown` 上游参与探索
  - `unsupported` 证据用于具体路由/重检逻辑，避免把明确不可用端点当成长期首选
- **representative_success_multiplier**：真实请求成功后的短期代表性证据加成，帮助刚被实际流量验证的上游获得更高选择概率
- **in_flight**：当前并发请求数，避免单点过载
- **latency_penalty**：基于最近请求延迟的惩罚
- **health_penalty**：基于 Health State 的惩罚（仅影响评分，不排除候选）
- **failure_penalty**：基于最近失败次数的惩罚

基于归一化分数进行**概率式抽选**，高分上游被选中概率更高，但低分上游仍有机会（负载均衡和探测性尝试）。

### 冷启动示例

```
场景：首次启动，所有上游都是新配置的，没有任何 verified 证据

配置：
  - rawchat: api: "openai", weight: 3
  - claude_site: api: "anthropic", weight: 2
  - unknown_site: api 未配置, weight: 1

客户端请求：Codex Desktop 发送 Responses 请求

第一阶段（基础过滤）：
  - rawchat: 通过 ✅
  - claude_site: 通过 ✅
  - unknown_site: 通过 ✅

第二阶段（协议筛选）：
  - rawchat: Responses 为 assumed ✅ 进入候选池
  - claude_site: Responses 为 unknown（anthropic 配置不假设支持 openai） ❌ 不进入
  - unknown_site: Responses 为 unknown ⚠️ 可以进入候选池（尝试验证）

第三阶段（评分选择）：
  - rawchat: weight=3，配置声明为 OpenAI family → 得分主要由权重、可用率、延迟、失败次数和代表性证据决定
  - unknown_site: weight=1，默认按 OpenAI-compatible 探索 → 得分主要由权重、可用率、延迟、失败次数和代表性证据决定
  - 概率选择：rawchat 概率更高，但 unknown_site 仍有探索机会

实际请求后：
  - rawchat 返回 200 + 正常输出 → Responses 标记为 verified
  - 下次同类请求：如果存在 verified Responses 候选，Selection 优先在 verified 候选池中抽选，并叠加真实流量代表性证据
```

### 关于 Health State 的说明

Health Probe 产生的 Health State（如 `ok`、`missing_key`、`rate_limited`、`server_error` 等）**不会影响上游在 Selection 中的可用性判断**，仅作为参考信息：

- **Health State 的作用**：
  - Dashboard 可视化展示（让用户了解上游状态）
  - 作为 `health_penalty` 影响评分（降低选中概率，但不完全排除）
  - 诊断和排障的参考依据

- **为什么不排除**：
  - Health Probe 使用的请求格式可能与实际 Codex 流量不同（Non-representative）
  - 上游商家返回格式不统一，探测结果可能不准确
  - 临时性错误不应该导致上游完全不可用
  - **只有实际流量的结果才是权威的可用性证据**

- **真正排除上游的条件**：
  - 用户手动 Disabled
  - 用户手动 Quarantined
  - 缺少必需的 Upstream Key（配置错误）
  - 处于 Cooldown（实际流量失败后的临时冷却）
  - OAuth token 明确过期
  - 模型类型不匹配（配置层面的硬性要求）
  - 协议能力明确为 `unsupported`（实际流量验证失败）

---

## 3. 多协议支持与自动适配

### 三种协议族原生支持

- **OpenAI Responses API**（Codex Desktop 原生）
- **OpenAI Chat Completions API**（通用兼容）
- **Anthropic Messages API**（Claude CLI 原生）

### 协议适配能力

- Responses → Chat Completions 转换（当无原生 Responses 上游时）
- Responses → Anthropic Messages 转换（当无原生 Responses 上游时）
- Messages → Chat Completions 转换（当无原生 Messages 上游、且显式启用 Messages 兼容适配时）
- Messages → Responses 转换尚未作为当前生产能力实现；需要 Responses 上游服务 Claude 客户端时，应优先配置原生 Anthropic Messages 上游或启用 Messages → Chat Completions 适配

### Adapter Compatibility Mode（可选兼容模式）

#### 默认行为（兼容模式关闭）

- 当请求包含 Responses-only 或 Messages-only 特性时
- 如果没有原生协议上游可用
- 返回 `422` 带详细诊断信息，**避免静默降级**
- 让用户明确知道当前无法无损转发

#### 启用兼容模式

配置示例：
```json
{
  "compatibility": {
    "adapter_mode": {
      "strip_responses_only_features": true,
      "adapters": {
        "anthropic_messages": true,
        "chat_completions": true
      }
    }
  }
}
```

启用后的行为：
- 允许有损协议转换，**优先保证请求成功**
- 详细记录转换过程：
  - **`converted`**：成功映射的字段（如 `input_image` → `image_url`）
  - **`downgraded`**：部分映射的字段（如 Responses `web_search` → Chat `web_search_options`）
  - **`stripped`**：无法映射的字段（如 `image_generation` 工具）
- 通过 `x-codex-api-pool-stripped` 响应头和 Recent Request Timeline 透明化所有转换操作
- **用户文本和多模态内容不会被静默剥离**，只有 API 特定功能字段才会被标记和剥离

### 字段映射示例

| Responses 字段 | Chat Completions | Anthropic Messages | 转换类型 |
| --- | --- | --- | --- |
| `input_image` | `image_url` content part | `image` content block | converted ✅ |
| `input_file` | `file` content part | `document` content block（PDF/text/URL） | converted ✅ |
| `custom_tool_call` | tool calls | `tool_use` | converted ✅ |
| `custom_tool_call_output` | tool messages | `tool_result` | converted ✅ |
| `custom` tools | custom tools | client tools | downgraded ⚠️ |
| `namespace` tools | 展开为带前缀的普通工具 | 展开为带前缀的普通工具 | downgraded ⚠️ |
| `web_search` / `web_search_preview` | `web_search_options` | `web_search_20260209` | downgraded ⚠️ |
| `tool_search` | ❌ 无等价字段 | `tool_search_tool_bm25_20251119` | stripped ❌（Chat）/ converted ✅（Anthropic） |
| `reasoning.effort` | `reasoning_effort` | `output_config.effort` | converted ✅ |
| `text.verbosity` | `verbosity`（顶层） | ❌ 无等价字段 | converted ✅（Chat）/ stripped ❌（Anthropic） |
| `image_generation` | ❌ 无等价工具 | ❌ 无等价工具 | stripped ❌ |
| `context_management`、`previous_response_id`、`conversation` 等 | ❌ 无等价字段 | ❌ 无等价字段 | stripped ❌ |

---

## 4. 智能容错与故障恢复

### 自动重试与 Fallback

- **可重试状态码**（默认）：
  ```
  400, 401, 403, 404, 408, 409, 425, 429,
  500, 502, 503, 504, 521, 522, 523, 524
  ```
- **最多重试次数**：默认 4 次（可配置 `retry.max_attempts`）
- **Fallback 策略**：失败后自动切换到其他健康上游，选择过程遵循 Selection 算法
- **失败类型**：网络错误、超时、HTTP 错误、上游流式中断等

### 冷却机制（Cooldown）

#### Upstream 级冷却
- 连续失败 N 次（默认 2 次，`retry.failure_threshold`）后触发
- 冷却时长：默认 30 秒（`retry.base_cooldown_ms`）
- 冷却期间该上游不参与 Selection
- 过期后自动恢复
  
#### Key 级冷却
- 认证错误（401/403）或配额错误（429）触发
- 冷却时长：默认 60 秒（`retry.key_cooldown_ms`）
- 同一上游的其他 Key 不受影响
- 所有 Key 都冷却时，上游整体不可用

### 流式边界管理（Streaming Boundary）⭐

这是一个**物理限制边界**，决定了 Pool 能否进行 Retry 和 Fallback：

- **边界定义**：上游返回 HTTP 200 并开始流式输出的时刻
- **边界前**（请求阶段）：
  - 可以 Retry（重新发送请求）
  - 可以 Fallback（切换到其他上游）
  - 选择逻辑完全由 Pool 控制
  
- **边界后**（流式阶段）：
  - Pool 直接转发流，不缓存内容
  - 中途断流无法无损续接（无法知道已生成多少内容）
  - 客户端请求失败，需要客户端重新发起完整请求
  - **这是确保不会产生重复或不一致生成内容的设计**

**流式边界示例**：
```
请求发送 → 等待响应 → 收到 HTTP 200 → [Streaming Boundary] → 开始流式输出
    ↓            ↓           ↓                                    ↓
可 Retry     可 Retry    可 Retry                           不可 Retry
可 Fallback  可 Fallback 可 Fallback                        不可 Fallback
```

### Native Responses Recheck（原生路由重检）

当上游从原生 Responses 降级到 Chat Completions 后：
- 定期重试原生 Responses 路由
- 默认间隔：30 分钟（`retry.native_responses_recheck_ms`）
- 目的：避免临时故障（如上游短时维护）导致永久协议降级
- 如果重检成功，协议能力重新标记为 `verified`

### 健康状态追踪（Health State）

Health Probe 产生的状态类型：
- `ok`：探测成功
- `missing_key`：缺少 API Key
- `rate_limited`：触达速率限制
- `server_error`：服务器错误
- `network_error`：网络错误
- `timeout`：请求超时
- `missing_model_override`：未设置全局模型（探测需要指定模型）
- `stale_model_override`：探测使用的模型与当前全局模型不一致

**重要说明**：
- Health State **不会排除上游在 Selection 中的候选资格**
- 仅作为 `health_penalty` 影响评分（降低选中概率）
- 仅用于 Dashboard 展示和诊断参考
- **只有实际流量的结果才是权威的可用性证据**

---

## 5. 可用性与配额管理

### 滚动窗口可用率（Availability）

这是基于**实际流量**的成功率统计，直接影响上游选择权重：

- **统计范围**：每个上游最近 50 次 Model Interaction Request（可配置 `availability.window_size`）
- **最小样本**：10 次（可配置 `availability.min_samples`），样本不足不惩罚
- **成功定义**：HTTP 2xx/3xx **且** 响应包含模型输出（`output_tokens > 0`）
- **失败定义**：
  - HTTP 4xx/5xx 错误
  - 网络错误、超时
  - 上游流式中断
  - 空输出或 `output_tokens = 0`

### 动态权重乘数

| 成功率 | 权重乘数 | 说明 |
| --- | --- | --- |
| ≥ 95% | **1.20×** | 极高可用，加成奖励 |
| ≥ 90% | **1.00×** | 高可用，标准权重 |
| ≥ 75% | **0.65×** | 中等可用，轻微惩罚 |
| ≥ 50% | **0.30×** | 低可用，较大惩罚 |
| < 50% | **0.08×** | 极低可用，严重惩罚 |
| < 10 samples | **1.00×** | 样本不足，不惩罚 |

### 不计入 Availability 的请求

- `/v1/models` 模型列表查询
- Health Probe（管理层探测）
- Billing Probe（账单查询）
- Management API 请求（`/pool/*`）

### 配额监控（Quota）

从上游响应头自动提取速率限制信息：

| 响应头 | 含义 |
| --- | --- |
| `x-ratelimit-remaining-requests` | 剩余请求数 |
| `x-ratelimit-remaining-tokens` | 剩余 Token 数 |
| `x-ratelimit-limit-requests` | 总请求限制 |
| `x-ratelimit-limit-tokens` | 总 Token 限制 |
| `x-quota-remaining` | 剩余配额 |
| `retry-after` | 建议重试等待时间（秒） |

- 用于判断是否触达速率限制
- 触达后触发 Key 级 Cooldown
- Dashboard 实时显示配额状态

### Token 用量统计（Usage）

**数据来源**：
- 响应体的 `usage` 字段（OpenAI/Anthropic 标准格式）
- 响应头（部分上游通过头部返回）
- SSE 流的最终事件（`[DONE]` 前的 usage 事件）

**统计维度**：
- 按上游聚合
- 按日期聚合
- 包含：`prompt_tokens`、`completion_tokens`、`total_tokens`

**导出接口**：
- JSON 格式：`GET /pool/usage/daily.json`
- CSV 格式：`GET /pool/usage/daily.csv`

**注意事项**：
- Pool 不估算 Token，只记录上游返回的数值
- 上游未返回 usage 信息时，该请求不计入统计

---

## 6. 账单信息管理（Billing）

### 自动探测

默认尝试 OpenAI-compatible 账单接口：
- **订阅信息**：`/dashboard/billing/subscription`
- **使用量**：`/dashboard/billing/usage?start_date={start_date}&end_date={end_date}`

自动提取字段：
- 余额（balance）
- 已消费（used）
- 总限额（limit）
- 货币单位（currency）

### 自定义账单配置

针对使用非标准接口的上游：

```json
{
  "billing": {
    "enabled": true,
    "base_url": "https://example.com",
    "subscription_path": "/api/billing",
    "usage_path": "/api/usage?start_date={start_date}&end_date={end_date}",
    "currency": "USD",
    "balance_field": "data.balance",
    "used_field": "data.used_amount",
    "limit_field": "data.limit",
    "amount_unit": "usd",
    "large_limit_threshold": 10000000,
    "trust_large_limits": false
  }
}
```

### 防护机制

- **HTML 登录页检测**：识别返回登录页面，标记为 `blocked`
- **Cloudflare Challenge 检测**：识别人机验证页面，标记为 `blocked`
- **浏览器防护检测**：识别其他 JS challenge 页面

**重要说明**：
- Billing 状态为 `blocked` **不影响模型接口的可用性判断**
- 账单接口和模型接口通常使用不同的鉴权/防护策略
- 仅用于 Dashboard 展示和用户参考

### 操作接口

- 刷新全部：`POST /pool/billing`（跳过 Quarantined Upstream）
- 刷新单个：`POST /pool/upstreams/:name/billing`（可手动刷新隔离区上游）

---

## 7. 模型管理

### Model Override（全局模型切换）

作用：在不改变客户端配置的情况下，替换请求中的 `model` 字段。

**CLI 快捷命令**：
```bash
npm run model -- gpt          # 切换到 gpt-5.5
npm run model -- claude       # 切换到 claude-opus-4-8
npm run model -- off          # 清空 override，使用客户端原始模型
npm run model -- <model>      # 自定义模型名（如 gpt-4o, claude-sonnet-4-6）
```

**HTTP 接口**：
```bash
curl -X POST http://127.0.0.1:8787/pool/model \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4-8"}'
  
# 清空 override
curl -X POST http://127.0.0.1:8787/pool/model \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": ""}'
```

**影响范围**：
- 所有客户端的模型请求
- Health Probe 也使用当前 Model Override
- 写入 `config.local.json`，重启后生效

### 模型发现（Discovered Models）

通过 Health Probe 调用上游的 `/v1/models` 接口获取模型列表：
- 自动发现上游支持的所有模型
- Dashboard 显示为可点击的 chips
- 点击 chip 可填充到探测输入框（临时 Probe Model）
- 用于展示、诊断、选择临时 Probe Model，以及处理上游模型后缀
- 不作为 Selection 的硬门控；Requested Model 是否真正可用以协议族配置和实际模型请求结果为准

### 上游模型后缀（Upstream Model Suffix）

某些非标准上游对标准模型名添加自定义后缀（如 `claude-opus-4-8-cc`）：

Pool 自动处理流程：
1. **发现阶段**：从 `/v1/models` 返回的 `claude-opus-4-8-cc` 中剥离 `-cc`
2. **存储阶段**：统一存储为标准名 `claude-opus-4-8`
3. **展示阶段**：Dashboard、Timeline、统计数据均显示标准名
4. **转发阶段**：发送请求到该上游时，自动重新附加 `-cc` 后缀

**配置示例**：
```json
{
  "name": "custom_site",
  "model_suffix_strip": "-cc"
}
```

> 配置键 `model_suffix_strip`（推荐）和 `model_suffix`（别名）均可识别。

### 模型兼容性检查

在 Selection 的第一阶段（基础过滤）中执行：

| 请求模型 | 上游 `api` 配置 | 结果 |
| --- | --- | --- |
| `gpt-5.5`、`gpt-4o` | `openai` | ✅ 通过 |
| `gpt-5.5`、`gpt-4o` | `anthropic` | ❌ 排除 |
| `gpt-5.5`、`gpt-4o` | `both` | ✅ 通过 |
| `claude-opus-4-8` | `openai` | ❌ 排除 |
| `claude-opus-4-8` | `anthropic` | ✅ 通过 |
| `claude-opus-4-8` | `both` | ✅ 通过 |

---

## 8. 多密钥支持

### Key 级隔离配置

每个上游可配置多个 API Key：

```json
{
  "name": "rawchat",
  "keys": [
    {"env": "RAWCHAT_KEY_1"},
    {"env": "RAWCHAT_KEY_2"},
    {"value": "sk-..."}
  ]
}
```

### Key 级独立状态追踪

每个 Key 独立维护以下状态（不共享）：
- **Health State**：`ok`、`missing_key`、`rate_limited`、`server_error` 等
- **Cooldown 时间**：认证/配额错误后的冷却
- **Quota 信息**：剩余请求数、Token 数
- **失败次数**：连续失败计数
- **最后使用时间**：用于负载均衡

### Key 级故障转移

自动 Fallback 流程：
```
请求到达 → 选择 rawchat 上游
  ↓
Key1 被选中 → 发送请求
  ↓
返回 429（配额耗尽）
  ↓
Key1 进入 Cooldown（60秒）
  ↓
重试：选择同一上游的 Key2
  ↓
Key2 发送成功 ✅
```

**所有 Key 都不可用的场景**：
- 所有 Key 都在 Cooldown
- 所有 Key 都返回 `missing_key`
- 所有 Key 都被速率限制
- → 该上游整体标记为不可用，排除出候选池

**Key 冷却过期后**：
- 自动恢复参与 Selection
- 当前实现优先选择失败次数较少的可用 Key；`lastUsedAt` 作为诊断信息记录

---

## 9. 运行时管理能力

### Management API（`/pool/*`）

完整的 RESTful 接口，支持：
- 状态查询（`GET /pool/status`）
- 上游管理（增删改查、启停、隔离/恢复）
- Health Probe（全部或单个）
- Billing 刷新（全部或单个）
- Model Override 切换
- Adapter 兼容模式配置
- JSON 批量导入
- Debug Lock 模式（隔离诊断）

### 可视化 Dashboard（`/pool/dashboard`）

本地操作控制台，提供：
- **Top Diagnostic Bar**：一眼看出 Pool 是否可用、降级或阻塞
- **Upstream Workbench**：密集行或卡片，显示可用性、健康、冷却、延迟、模型、用量、账单
- **Recent Request Timeline**：最近请求详情（上游、模型、状态、耗时、token、重试、Fallback 证据）
- **Upstream Editor**：添加/编辑上游的表单
- **Quarantine 抽屉**：隔离区上游折叠展示
- **操作面板**：Health Probe、Billing 刷新、Model Override 切换、JSON 导入、Debug Lock

### 热更新

- 所有 Management API 操作无需重启服务
- 配置变更自动写回 `config.local.json`
- Runtime State 自动持久化到 `stats.local.json`

### 配置持久化

- `config.local.json`：用户配置（上游、权重、Key 引用、重试规则等）
- `stats.local.json`：运行时状态（Usage、Quota、Health、Cooldown、Availability、Recent Requests）
- `secrets.local.json`：Codex OAuth secrets（JWT、refresh token 等）

---

## 10. 安全与鉴权

### 三层 Token 隔离

| Token 类型 | 配置字段 | 用途 | 是否转发 |
| --- | --- | --- | --- |
| **Pool Token** | `server.auth_token_env` | 客户端访问本地 Pool（`/v1/*`） | ❌ 不转发 |
| **Admin Token** | `server.admin_auth_token_env` | 访问 Management API（`/pool/*`） | ❌ 不转发 |
| **Upstream Keys** | `upstreams[].keys[].env` | Pool 调用外部上游 | ✅ 仅转发给对应上游 |

### 环境变量引用（推荐）

```json
{
  "server": {
    "auth_token_env": "CODEX_POOL_API_KEY"
  },
  "upstreams": [
    {
      "keys": [{"env": "RAWCHAT_API_KEY"}]
    }
  ]
}
```

### 明文存储（不推荐）

```json
{
  "keys": [{"value": "sk-..."}]
}
```
- 仅用于确认本机文件安全的场景
- Dashboard 会显示明文警告

### 鉴权规则

- 配置了 token env 但进程读不到环境变量 → 请求被拒绝
- 显式留空 → 关闭该层鉴权（仅监听 `127.0.0.1` 时可接受）

---

## 11. 高级诊断功能

### Recent Request Timeline

记录最近 30 条 Model Interaction Request（可配置），包含信息：
- 时间戳、请求方法、路径
- 选中的上游、使用的 Key
- 原始模型、实际发送模型
- 协议路线（Native/Adapter/Compatibility）
- 状态码、耗时、Token 消耗
- Retry/Fallback 证据
- 协议转换详情（converted/downgraded/stripped）
- 完整的客户端原始请求头和请求体（可选，需启用 `debug.capture_request_headers`）

### Health Probe（健康探测）

- 手动触发：全部或单个上游
- 临时 Probe Model：单次探测指定模型（不修改全局 Model Override）
- 探测内容：
  - 基础可用性（延迟、响应状态）
  - 模型列表发现（`/v1/models`）
  - **不作为协议能力的权威判断**（避免商家格式不统一导致误判）
- OpenAI-compatible Probe 默认使用 browser-like User-Agent，避免某些上游的客户端限制
- Anthropic Messages Probe 默认使用 Claude CLI-compatible headers（含 1m context beta），减少 Claude 类上游对合成测试请求的误判

### Debug Lock Mode（隔离诊断）⭐

- **作用**：绕过 Selection，强制所有请求发往特定上游
- **协议尝试序列**：
  - Responses 请求 → 依次尝试：Native Responses → Chat Completions Adapter → Anthropic Messages Adapter
  - Messages 请求 → 仅尝试：Native Anthropic Messages
- 遇到 Endpoint Not Found Signal（404/405/501 或明确的不支持消息）→ 自动 Fallback 到下一个协议
- 所有协议失败 → 返回详细的 Debug Attempt Diagnostics：
  - 每个尝试的协议、端点 URL、HTTP 状态、错误体、延迟、Fallback 原因
  - Adapter 在生产配置中是否被禁用
- Session-only（不持久化），不更新 Runtime State（除 Timeline）

### 请求完整捕获（可选）

```json
{
  "debug": {
    "capture_request_headers": true,
    "request_log_path": "requests.debug.log"
  }
}
```

启用后记录：
- 客户端原始请求头（包括 Authorization、User-Agent 等敏感信息）
- 客户端原始请求体（协议转换前的完整 payload）
- 路由信息、响应状态、Token 消耗

存储位置：内存（30 条）、`stats.local.json`、`requests.debug.log`

日志分析脚本：
```bash
./scripts/view-request-log.sh        # 查看最近 10 条
./scripts/analyze-request-log.sh     # 统计分析
./scripts/extract-request.sh --last  # 提取最后一个请求
```

### 协议转换诊断

- 响应头：`x-codex-api-pool-stripped`（列出被剥离的字段）
- Timeline 详细记录：
  - `converted`：成功映射的字段
  - `downgraded`：部分映射的字段
  - `stripped`：无法映射的字段

---

## 12. Codex OAuth 支持

### 导入 Codex OAuth 账号

- 来源：sub2api、cpa 或 Codex OAuth account export JSON
- 通过 Management API 或 Dashboard 导入
- 自动识别 ChatGPT Web session（不作为可用上游）

### Token 管理

- JWT 元数据解析（过期时间、账号信息）
- **Access token 自动刷新（基于过期时间）**：转发请求前，若 access token 已过期或即将过期（默认提前 60 秒安全余量），Pool 自动使用存储的 `refresh_token` + `client_id` 向 `https://auth.openai.com/oauth/token` 发起 `grant_type=refresh_token` 刷新
  - 刷新成功：更新 `secrets.local.json` 中的 `access_token` / `expires_at`（若返回新 `refresh_token` 一并更新），并立即更新运行时 key 值与 `oauthExpiresAt`，请求继续转发（对客户端无感）
  - 刷新失败（网络错误、4xx、无 refresh_token 等）：该上游进入临时冷却，从本轮 Selection 排除，自动 Fallback 到其他上游；不影响 Availability 统计
  - 刷新是尽力而为（best-effort），永不抛异常；失败时保持"不发错误请求"的安全降级
- **Refresh token 过期检测**：刷新失败即视为 refresh_token 已失效（或被吊销），此时上游被临时排除；重新导入新的 Codex OAuth export 即可恢复
- OAuth 路由：识别为 `request_mode: "codex_oauth"` 的上游，按 Codex OAuth 需要的 headers 转发到 ChatGPT Codex backend

### Secret 隔离存储

- 敏感信息存储到 `secrets.local.json`（不提交到 Git）
- `config.local.json` 只保存账号引用
- 运行时 materialize 并投影到 Runtime State

### OAuth 请求路由

- 识别为 `request_mode: "codex_oauth"` 的上游
- 按 Codex OAuth 需要的 headers 转发到 ChatGPT Codex backend
- Token 过期时自动从候选排除

---

## 13. 高级管理特性

### 上游隔离区（Quarantine）

**作用**：将不稳定上游移出主流程，但保留配置和数据

隔离后：
- 不参与 Selection
- 不影响主页面的 Health Probe 汇总
- 不影响模型候选列表
- 保留在 Dashboard 隔离区抽屉中（默认折叠）
- 可手动执行 Health Probe 和 Billing 刷新

恢复：`POST /pool/upstreams/:name/quarantine {"quarantined": false}`，会立即执行单站 Health Probe

### Request Interface 学习

- 记录每个上游对特定模型成功使用的协议接口
- 示例：`rawchat` + `gpt-5.5` → Responses（成功）→ 下次优先用 Responses
- 避免每次都尝试协议发现

### Forwarding Strategy（转发策略）

- 基于实际成功流量学习的路由策略
- 非永久性：会被 Native Responses Recheck 或更强证据更新
- 避免盲目重试，提高转发效率

### 协议能力证据管理

证据状态：
- `verified`：实际请求成功（最高优先级）
- `unsupported`：实际请求失败（明确不支持）
- `assumed`：基于配置声明
- `unknown`：未探测

证据来源优先级：实际流量 > 配置声明

每种协议能力（Responses、Chat Completions、Messages）独立追踪

### 代理支持

```json
{
  "proxy_url": "http://127.0.0.1:7897"
}
```
- 为单个上游配置 HTTP 代理
- HTTPS 请求自动走 CONNECT 隧道

### 签到状态管理

- 标记：`signin_available: true`
- Dashboard 显示签到状态
- 手动更新：`POST /pool/upstreams/:name/signin`

---

## 14. 运维友好

### macOS LaunchAgent（守护进程）

```bash
npm run service:install    # 创建并加载 LaunchAgent
npm run service:status     # 检查服务状态
npm run service:restart    # 重启服务
npm run service:stop       # 停止服务
npm run service:uninstall  # 卸载 LaunchAgent
```

- Label：`com.slizm.codex-api-pool`
- plist 路径：`~/Library/LaunchAgents/com.slizm.codex-api-pool.plist`
- 日志输出：
  - stdout：`pool.out.log`
  - stderr：`pool.err.log`
- 自动加载 `~/.zshrc` 环境变量

### CLI 工具集

```bash
# 添加上游
npm run add -- <name> <base_url> <weight> <key_env> [options]

# 切换模型
npm run model -- gpt|claude|off|<model>

# 服务管理
npm run service:install|status|restart|stop|uninstall
```

### 批量导入

支持格式：sub2api、cpa、通用 JSON

Dashboard 上传或 HTTP 接口：
```bash
curl -X POST 'http://127.0.0.1:8787/pool/import/upstreams?replace=false&secret_mode=env' \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY" \
  -d @upstreams.json
```

Secret 模式：
- `secret_mode=env`：生成环境变量名（推荐）
- `secret_mode=value`：保存明文 Key（带警告）

### 日志管理

- 结构化请求日志：`requests.debug.log`（每行一条 JSON）
- 分析脚本：
  ```bash
  jq -r '.upstream // "null"' requests.debug.log | sort | uniq -c  # 按上游统计
  jq 'select(.outcome == "error")' requests.debug.log              # 失败请求
  ```
- stdout/stderr 分离
- 支持 `jq`/`grep` 分析

### nohup 兜底（launchd 不可用时）

```bash
nohup /bin/zsh -lc 'source ~/.zshrc; exec node /path/to/server.mjs /path/to/config.local.json' \
  >> pool.out.log 2>> pool.err.log < /dev/null &
```

### 健康检查

```bash
curl -s http://127.0.0.1:8787/health              # 服务存活
curl -s http://127.0.0.1:8787/pool/status         # 完整状态
lsof -nP -iTCP:8787 -sTCP:LISTEN                  # 端口监听
```

---

## 15. 测试与质量保证

### 烟雾测试

```bash
npm run smoke
```

覆盖场景：
- Pool Token 鉴权
- 上游选择与 Fallback
- 启用/停用切换
- Usage 和 Availability 统计
- JSON 导入（上游和 Codex OAuth 账号）
- 模型发现
- Model Override 切换
- 流式错误处理和 Cooldown
- HTTP 400/522 Fallback 行为
- Recent Request Timeline

### 轻量回归测试

- 当前测试体系以原生 Node `.mjs` 脚本为主，不依赖额外测试框架
- `test/*.mjs` 覆盖 Selection、Retry、协议适配、Dashboard、Debug Lock、Codex OAuth、Billing 等关键行为
- 烟雾测试仍是端到端质量门禁，修改 Selection、Retry、协议适配、Management API 或 Dashboard 后应运行相关聚焦测试，并在风险较高时运行烟测

---

## 核心价值

1. **双客户端统一入口**：Codex Desktop 和 Claude CLI 可同时使用同一个 Pool，自动识别请求类型并路由到最佳上游
2. **原生协议优先**：通过 Protocol Matching 策略和实际流量验证，优先使用无损转发路由，最大化保留请求特性
3. **商家兼容性强**：通过两层协议发现机制，适应各上游商家返回格式不统一的现状
4. **高可用**：通过多维度选择、故障转移、重试、冷却确保请求成功率
5. **协议透明**：自动处理不同上游的协议差异，对客户端无感
6. **可观测性**：丰富的状态信息、请求追踪、协议转换诊断工具
7. **易管理**：Web Dashboard + CLI 工具 + 热更新 + 批量导入
8. **安全隔离**：三层 Token 分离，Pool Token 不转发，Key 级独立管理
9. **智能学习**：基于实际流量学习协议能力和转发策略，持续优化路由决策
10. **运维友好**：守护进程、结构化日志、完整诊断工具链

---

## 常见问题

### Q: Health Probe 失败是否意味着上游不可用？

A: 不一定。Health Probe 只是基础监测，**不作为权威判断**。探测失败可能是：
- 探测请求格式与实际流量不同
- 上游对探测工具有限制
- 临时网络波动

只有**实际流量失败**才是权威证据，会触发 Cooldown 和协议能力更新。

### Q: 如何知道请求使用了哪个上游和协议？

A: 查看 Recent Request Timeline：
- Dashboard：`http://127.0.0.1:8787/pool/dashboard`
- API：`GET /pool/status | jq '.recent_requests'`

### Q: 如何强制使用特定上游进行诊断？

A: 使用 Debug Lock Mode：
```bash
curl -X POST http://127.0.0.1:8787/pool/upstreams/rawchat/debug-lock \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"respect_model_override": true}'
```

### Q: 协议转换会丢失哪些信息？

A: 查看响应头 `x-codex-api-pool-stripped` 和 Timeline 的详细转换记录。常见被剥离的：
- `image_generation`（Chat/Anthropic 无等价工具）
- `context_management`、`conversation`（Responses 独有）
- `tool_search`（Chat 无等价字段）

### Q: 如何避免协议转换？

A: 
1. 确保至少一个上游支持客户端的原生协议
2. 正确配置上游的 `api` 字段
3. 让实际流量验证协议能力（标记为 `verified`）
4. 如无原生上游且不接受有损转换，关闭 Adapter Compatibility Mode（默认关闭）

# 更新日志

## 2026-06-12 CST

本次更新按 Representative Model Probe 架构复审结果继续收敛实现边界，目标是减少健康探测、真实请求、Selection 和 Dashboard 之间的重复判断。

- 新增 Representative Availability 汇总投影，将 key-level representative evidence 统一解释为 `fresh`、`stale` 或 `missing`，并通过 `/pool/status.upstreams[].representative_availability` 暴露。
- Selection 的 representative multiplier 改为读取同一 Representative Availability 汇总；真实 Codex 成功会在 fresh 期间提供小幅加权，但仍保持加权随机负载均衡。
- 将 synthetic probe 的分类辅助函数集中化，并把 OpenAI Responses + Chat Completions 双探测组合决策抽出为独立决策函数，避免 `probeOneUpstream` 内继续扩散 authoritative / non-representative 语义。
- 将 Model Interaction Request 的结果记录统一到单一 outcome helper，集中处理 response stats、Availability、token usage、成功状态和真实请求失败/cooldown 逻辑。
- 拆分 `/pool/status` 的 Upstream/Key view projection，减少 Management Dashboard payload 与 Runtime State 的直接耦合。
- smoke 测试补充 Representative Availability 断言，覆盖 synthetic probe 后 `missing`、真实 Codex 成功后 `fresh + real_traffic`，以及后续 synthetic probe 不抹除真实请求证据。
- Representative Request Template 现在只保留红acted 元数据和 replay-risk header 名称，例如 `headers.x-oai-attestation`；手动 Health Probe 不再重放内存模板，避免一次性字段导致无意义测试。
- Management API probe 失败时会在本次响应中返回 `health.upstream_result`，包含上游状态码、响应头、响应体、错误和 retry-after，便于后续判断。
- 基于真实 rawchat 上游复测修正 auto request-mode 学习条件：只有解析到具体模型输出的真实请求才会写入 `resolvedRequestMode` 和 `real_traffic` 证据，避免 `HTTP 200 + code/msg/data:null` 这类商家业务错误把上游误学习为 chat-only 并短路后续真实请求验证；同时 success accounting 现在会解析 gzip/br/deflate JSON/SSE 响应体。

### Dashboard 稳定排序

- Upstream Workbench 默认排序改为启用状态分组后按 Pool Configuration 顺序稳定展示；`selection_score`、`selection_weight`、Availability、失败次数、延迟和 Verification Tier 继续展示/筛选，但不再让行在刷新时频繁换位。
- `/pool/status.upstreams[]` 新增 `config_index`，让 Management Dashboard 能在 Runtime State 变化时保留配置顺序。
- smoke 测试新增 Dashboard 渲染级行为覆盖，验证动态 Runtime State 大幅变化后 Workbench 行顺序仍保持稳定。

### API Pool 报错展示分类

- 模型请求失败响应新增只读 `error_display` 投影，按 `layer/category/severity/title/message/action` 描述错误来源；现有 `error`、`reason`、`attempts`、HTTP status、Retry、Cooldown 和 Selection 逻辑保持不变。
- 覆盖无 Upstream 配置、无可用候选、上游 rate limit/auth/timeout/network/server failure，以及 Native Responses Route 兼容性失败等展示分类。
- Recent Request Timeline 记录同一 `error_display`，Top Diagnostic Bar 优先展示分类后的可读文案，缺失时继续回退旧 `reason`。

### 验证

已通过：

```bash
node --check src/server.mjs
node --check test/smoke-test.mjs
npm run smoke
node -e 'import("./src/server.mjs").then(async ({createPoolServer}) => { const server = createPoolServer({ server: { host: "127.0.0.1", port: 0, public_prefix: "/v1", auth_token_env: "" }, health: { enabled: false }, upstreams: [{ name: "usage-site", base_url: "http://127.0.0.1:1/v1", weight: 1, keys: [] }] }); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); const { port } = server.address(); const response = await fetch(`http://127.0.0.1:${port}/pool/dashboard`); const html = await response.text(); const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]); for (const script of scripts) new Function(script); server.close(); console.log(`dashboard scripts parse ok (${scripts.length})`); })'
```

## 2026-06-11 CST

本次更新修复 Codex Desktop 真实请求可用、但 Management Dashboard 健康监测误判 Upstream 不可用的问题。核心变化是引入 Representative Request Template 和 Representative Model Probe，让手动健康监测能复用真实 Codex Desktop 请求形状，而不是只依赖 synthetic Health Probe。

### Representative Model Probe

- 从已通过 Pool Token 鉴权的真实 Codex Desktop `/v1/responses` Model Interaction Request 捕获内存-only Representative Request Template。
- Template 只保留请求形状和必要 Codex context header，例如 `x-oai-attestation`；不持久化、不写入配置、不展示原始敏感值。
- Template body 替换用户输入为最小无害探测内容 `Respond with OK.`，并剔除 `metadata`、`previous_response_id`、用户 prompt 和会话内容。
- 手动 Dashboard Health Probe 在存在 fresh Codex Desktop template 时优先运行 Representative Model Probe；后台定时 Health Probe 不重放 template。
- Representative Model Probe 成功会设置 `health.source = representative_probe`，与普通 `probe` 和 `real_traffic` 区分。

### Probe 分类与 Selection

- 新增 `inconclusive` Health State：商家自定义、无法稳定归因的 `400/403/5xx` 等探测错误不会直接阻断 Selection。
- synthetic Health Probe 返回 `invalid_responses_request` / `invalid Codex request` 时继续视为 non-representative，不再把 `any` 这类 Codex-context-gated Upstream 错判不可用。
- Representative Model Probe 或真实 Codex 请求中的同类错误按代表性请求失败处理，不再降级为 synthetic-only 诊断。
- 代表性成功证据按 `Upstream Key + protocol + model` 记录，带 30 分钟 freshness，并通过 `/pool/status.upstreams[].keys[].representative_evidence` 暴露。
- Selection 保持加权随机和负载均衡，只对 fresh representative probe evidence 施加小幅 multiplier，不做固定优先级队列。
- 真实 Codex 非权威失败前两次不立即 cooldown；连续三次才触发短 cooldown。Auth、rate limit、network、timeout、Cloudflare 52x 等强失败仍立即走原 cooldown 逻辑。

### Dashboard

- `/pool/status` 顶层新增 `representative_templates`，只展示 template freshness、模型和 redacted header 名称。
- Upstream Workbench 增加 `Codex Desktop Template fresh/stale/missing` 读数，方便判断手动健康监测是否具备代表性。
- Health State `ok` 现在保留来源：synthetic probe、representative probe、real traffic 可在状态 payload 中区分。

### 文档与测试

- `CONTEXT.md` 增加 Representative Model Probe、Representative Request Template、Authoritative Probe Failure 和 Non-representative Probe Result 术语。
- 新增 ADR：`docs/adr/0003-non-authoritative-probes-do-not-block-selection.md`。
- 新增 PRD：`docs/prd-representative-model-probe.md`，并发布为 GitHub Issue #21。
- smoke 测试覆盖：
  - any-like Upstream synthetic probe 失败但真实 Codex Desktop 请求成功。
  - 真实 Codex Desktop 请求后，手动健康按钮使用 Representative Model Probe。
  - ambiguous merchant probe error 进入 `inconclusive` 且保持 selectable。
  - Representative success evidence 写入 key/protocol/model 作用域。
  - 非权威真实失败连续三次才 cooldown。

### 验证

已通过：

```bash
npm run smoke
node -e 'import("./src/server.mjs").then(async ({createPoolServer}) => { const server = createPoolServer({ server: { host: "127.0.0.1", port: 0, public_prefix: "/v1", auth_token_env: "" }, health: { enabled: false }, upstreams: [{ name: "usage-site", base_url: "http://127.0.0.1:1/v1", weight: 1, keys: [] }] }); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); const { port } = server.address(); const response = await fetch(`http://127.0.0.1:${port}/pool/dashboard`); const html = await response.text(); const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]); for (const script of scripts) new Function(script); server.close(); console.log(`dashboard scripts parse ok (${scripts.length})`); })'
```

## 2026-06-09 CST

本次更新优化检测网站的站点排序规则，让页面顺序更贴近真实 Selection 状态。

### Selection 排序

- `/pool/status.upstreams[]` 新增 `selection_score`：可用站点按 `selection_weight` 继续叠加 in-flight、延迟、Health State 和连续失败惩罚；不可用站点分数为 `0`。
- Dashboard 列表先按启用状态硬分组：所有启用站点在上方，未启用站点全部沉底；启用组内再按可用性、`selection_score`、`selection_weight`、失败次数和延迟排序。
- 签到状态不参与站点排序，只用于筛选、状态展示和签到操作。
- 站点卡片的 Selection 行增加 `Score`，用于解释为什么某个站点虽然基础权重高，但会因为冷却、并发、延迟或失败记录下沉。

### 测试

- smoke 测试补充动态分数断言，覆盖稳定低权重站点排在低可用高权重站点前、冷却站点 `selection_score` 归零。

## 2026-06-08 17:31 CST

本次更新补齐 Codex API Pool 的手动模型切换能力，并把 Claude/Anthropic 上游从“单一类型”改为“协议能力”模型，支持同一个上游同时服务 GPT/Codex 和 Claude。

### 模型切换

- 新增 `scripts/set-model.mjs`，通过现有 Management API `POST /pool/model` 切换代理级 `model_override`。
- `package.json` 新增 `npm run model`，支持快捷别名：
  - `gpt` -> `gpt-5.5`
  - `claude` -> `claude-opus-4-8`
  - `off` -> 清空 `model_override`
- 切换后脚本会读取 `/pool/status`，输出当前 override、可用上游数量和匹配当前模型的上游数量。
- 脚本默认读取 `CODEX_POOL_API_KEY` 作为管理 token；如果本地 Management API 未启用鉴权，也允许无 token 调用。

### Claude / Anthropic 能力

- Upstream 新增协议能力语义：
  - `api: "openai"`：参与 GPT/Codex/OpenAI-compatible Selection。
  - `api: "anthropic"`：参与 Claude `/v1/messages` Selection。
  - `api: "both"`：同时参与 GPT/Codex 和 Claude Selection。
- 选择 `claude-*` 模型时，只允许具备 Anthropic 能力的上游参与，避免 Claude 请求误打普通 OpenAI-compatible 上游。
- 选择非 Claude 模型时，不再跳过 `api: "both"` 上游；只跳过 Anthropic-only 上游。
- 保留旧配置兼容：`probe_auth: "anthropic"` 会被视为具备 Anthropic 能力。
- 当前本地 `runanytime_claude` 已补充 `api: "anthropic"` 标记。

### 自动检测

- 新增上游时，如果未显式传 `api` 或 `probe_auth`，代理会在常规 OpenAI-compatible 健康探测后，额外尝试 Anthropic `/v1/models` 探测。
- OpenAI-compatible 探测成功且 Anthropic 探测也成功并发现 `claude-*` 模型时，自动持久化为 `api: "both"`。
- OpenAI-compatible 探测失败但 Anthropic 探测成功并发现 `claude-*` 模型时，自动持久化为 `api: "anthropic"`，并补 `probe_auth: "anthropic"` 与默认 `health_path: "/v1/models"`。
- 只有 OpenAI-compatible `/models` 列出 Claude 模型，但 Anthropic 探测失败时，不自动标记 Anthropic，避免后续误打 `/v1/messages`。

### 文档与测试

- `README.md` 增加 `npm run model` 用法、`api: "both"` 示例和自动协议检测规则。
- `scripts/add-upstream.mjs` 增加 `--api openai|anthropic|both` 参数说明与透传。
- `config.example.json` 增加 Anthropic 上游示例。
- smoke 测试新增覆盖：
  - 模型切换脚本别名解析和匹配上游统计。
  - Claude Selection 跳过未标记 OpenAI-only 上游。
  - 非 Claude Selection 允许 `api: "both"`，但跳过 Anthropic-only 上游。
  - 新增上游自动检测 `api: "anthropic"` 和 `api: "both"`。

### 验证

已通过：

```bash
node --check src/server.mjs
node --check scripts/set-model.mjs
node -e "for (const f of ['config.example.json','config.local.json']) { JSON.parse(require('fs').readFileSync(f,'utf8')); console.log(f + ' ok'); }"
npm run smoke
```

## 2026-06-08 16:43 CST

本次更新新增 Upstream Availability 能力：根据每个上游最近 50 次真实模型请求尝试统计可用率，并把该可用率接入 Selection 优先级。

### Availability

- 每个 Upstream 和 Upstream Key 新增滚动可用率窗口，默认保存最近 50 次真实模型请求尝试结果。
- `2xx/3xx` 响应计为成功；其他 HTTP 状态、网络错误、超时和上游流式中断计为失败。
- Health Probe 不计入 Availability，避免探测结果稀释真实 Codex 调用表现。
- Availability 样本写入 `stats.local.json`，服务重启后继续参与优先级判断。
- 客户端主动取消请求时不惩罚 Upstream，避免人为中断污染可用率。

### Selection

- Selection 保留原有硬过滤：Disabled、Cooldown、missing key、模型不匹配和缺少 base URL 的 Upstream 仍不会参与选择。
- 在通过硬过滤的候选之间，按 `availability.multiplier` 调整原始权重，近期可用率越高越优先。
- 默认分段策略：
  - 样本少于 10 次：`1.00`
  - `>= 95%`：`1.20`
  - `>= 90%`：`1.00`
  - `>= 75%`：`0.65`
  - `>= 50%`：`0.30`
  - `< 50%`：`0.08`
- `/pool/status.upstreams[]` 新增 `availability` 和 `selection_weight`，便于解释当前调度优先级。

### Dashboard

- Upstream Workbench 的 Selection 列新增 Availability 百分比、样本数、水平进度条和最近 50 次调用小色块历史。
- Dashboard 列表按 `selection_weight` 排序，使页面展示顺序更贴近实际调度优先级。
- 可视化保留原有运维工作台风格，避免把 Health State、Cooldown、Usage 和 Billing 信息挤出主视图。

### 配置与文档

- `config.example.json` 新增 `availability` 配置，可调整窗口大小、最小样本数和分段阈值。
- `README.md` 增加 Availability 字段说明、默认 multiplier 规则、配置示例和 dashboard 展示说明。
- `CONTEXT.md` 增加 `Availability` 领域术语，并更新 Selection 定义。

### 测试

- smoke 测试新增 Availability scoring 覆盖：验证低可用率高权重上游会被压低，稳定低权重上游会优先。
- smoke 测试新增 Availability 持久化覆盖：验证重启后仍会读取最近窗口并继续参与 Selection。
- smoke 测试新增上游流式中断覆盖：验证 `200` 后断流会记录 Availability 失败、进入冷却并在后续请求中被跳过。

### 验证

已通过：

```bash
node --check src/server.mjs
node --check test/smoke-test.mjs
npm run smoke
```

## 2026-06-08 16:41 CST

本次更新收敛余额查询实现，并补齐 Claude/Anthropic 调用与上游流异常处理，目标是让 billing 功能保持附加能力，不影响主 `/v1` 调用链。

### Billing 回退

- 余额查询恢复为默认 OpenAI-style subscription/usage 逻辑：`/dashboard/billing/subscription` + `/dashboard/billing/usage?start_date={start_date}&end_date={end_date}`。
- 不再获取用户钱包余额，不再调用 AnyRouter/New API 用户钱包接口，也不再依赖网页登录态 cookie、`New-API-User`、本地 secret store 或代理配置。
- 当站点 token 生成时设置了具体总金额时，会继续通过 `hard_limit_usd` / `total_usage` 推导余额；如果站点返回超大占位额度，仍按“不限/占位”处理并保留可信的已用金额。
- billing 探测失败、缺少可用账单接口、返回 HTML 登录页或 Cloudflare challenge 时，只隐藏余额或标记 `blocked/unavailable`，不影响模型请求主链路。
- 移除 dashboard 中 AnyRouter Session 相关面板、`/pool/secrets` 接口、wallet/cookie/proxy 类 billing 配置字段和示例文档。

### Claude 调用

- 对所有最终模型名以 `claude` 开头的请求，统一走 Anthropic 官方 Messages 调用形式，并将结果适配回 OpenAI Responses 兼容输出。
- 当 `model_override` 被切到 Claude 时，只选择标记为 `api: "anthropic"` 或 `probe_auth: "anthropic"` 的上游；非 Claude 模型不会误选 Anthropic-only 上游。
- 明确保留“请求本身已经是 Claude 模型时不被非 Claude override 改写”的行为，避免网页端或 Codex 端切换模型后打错上游协议。

### 主链路稳定性

- 修复上游流式响应提前 `error/aborted/close` 时没有完整记账和冷却的问题；现在会记录为 `stream_error`、状态 `502`，并冷却失败上游。
- 流式响应统计改为在上游完整 `end` 后记录成功，避免“上游显示有输入输出，但 Codex 没收到完整输出”时仍被记为成功。
- 对网络级 `statusCode === 0`、Cloudflare 52x、400/5xx 等 retryable 错误继续执行站点冷却和后续候选切换，保障下一次请求优先避开故障站点。

### 文档与测试

- README 更新余额说明：billing 只读取 API key 可访问的账单端点，不再抓取网页登录态、用户钱包或 cookie 保护页面。
- `config.example.json` 移除 wallet/credits/proxy/cookie 类配置字段，并补充 Claude/Anthropic 上游标记示例。
- smoke 测试覆盖 billing 主链路隔离、超大占位额度、HTML-protected billing blocked、Claude Anthropic adapter、Claude/非 Claude 上游选择、流式异常冷却和每日 token 导出。

### 验证

已通过：

```bash
node --check src/server.mjs
node --check test/smoke-test.mjs
node -e "const fs=require('fs'); for (const f of ['config.local.json','config.example.json']) { JSON.parse(fs.readFileSync(f,'utf8')); console.log(f+': ok') }"
npm run smoke
```

## 2026-06-08 12:55 CST

本次更新新增“每日 token 历史”能力，在原有站点累计 token 统计基础上，补齐按天持久化、dashboard 展示和下载导出。

### Token 历史

- 每次成功响应记录 token 时，除累计 `totalTokens` 外，新增写入 `stats.tokenUsage.daily[YYYY-MM-DD]`。
- 每日记录按本机时区日期切分，字段包含 `totalTokens`、`inputTokens` 和 `outputTokens`，到本地 0 点后自动进入新日期。
- 保留旧的 `stats.tokenUsage.byDay` 总量字段，兼容已有 `stats.local.json` 历史数据。
- `/pool/status.usage` 新增 `daily`、`today_input_tokens`、`today_output_tokens`。
- `/pool/status.upstreams[].usage` 新增单站点 `daily`、`today_input_tokens`、`today_output_tokens`。

### 下载导出

- 新增 `GET /pool/usage/daily.json`，导出完整每日 token 历史，包含 `summary` 和按 `date + upstream` 展开的 `rows`。
- 新增 `GET /pool/usage/daily.csv`，导出表格格式：`date, upstream, input_tokens, output_tokens, total_tokens`。
- 导出接口复用管理接口鉴权，避免启用外部监听时泄露使用量历史。

### Dashboard

- 新增 `Daily Token Usage` 面板，默认展示最近 14 天每日 token 总量、input、output 和参与站点数量。
- 每天记录支持展开查看站点明细，便于定位某一天 token 主要消耗在哪些上游。
- 新增“下载 CSV”和“下载 JSON”按钮，直接从 dashboard 下载完整历史数据。

### 测试

- smoke 测试新增每日 token 明细断言，覆盖站点级 `daily`、全局 `daily`、JSON 导出和 CSV 导出。

## 2026-06-07 18:26 CST

本次更新修复“只能看到 quota/token，无法查看具体余额和已消费金额”的问题，新增独立 billing 探测能力。

### Billing

- 新增本地 `secrets.local.json` secret store，dashboard 可以写入 `ANY_SESSION_COOKIE`、`ANY_NEW_API_USER` 和 `ANY_BILLING_PROXY`，运行中立即生效，无需重启服务。
- 新增 `billing.proxy_env` / `billing.proxy`，余额探测可通过本地 HTTP 代理访问上游网页登录接口，适配 AnyRouter 这类命令行直连 TLS 不稳定但浏览器代理可访问的站点。
- 修复 AnyRouter / New API 用户接口返回 gzip/br/deflate 压缩 JSON 时被误判为 `no_amount` 的问题。
- 优化请求失败后的路由冷却：`400/5xx/Cloudflare 52x` 等 retryable 错误会立即冷却失败站点，连续失败会逐步拉长冷却时间；当明确支持当前模型的站点都在冷却时，会保持同一模型尝试其他可用站点。
- 每个站点新增 `billing` 运行态，包含 `balance_amount`、`used_amount`、`limit_amount`、`currency`、`period_start`、`period_end` 和探测状态。
- `/pool/status` 顶层新增 `billing` 汇总，支持按币种聚合全部站点余额、已消费金额和额度上限。
- `/pool/status.upstreams[].billing` 新增单站点余额/已消费金额详情。
- 新增 `POST /pool/billing`，用于刷新所有启用站点的 billing 信息。
- 新增 `POST /pool/upstreams/:name/billing`，用于只刷新单个站点的 billing 信息。
- 默认兼容 OpenAI-style `/dashboard/billing/subscription` 和 `/dashboard/billing/usage?start_date={start_date}&end_date={end_date}`。
- 默认会同时兼容 origin 下的 billing 路径和保留 `base_url` 前缀的 billing 路径，例如 any 的 `/v1/dashboard/billing/...`。
- 支持通过 upstream 的 `billing` 配置自定义 base URL、路径、鉴权方式、请求头、金额字段、币种字段和金额单位。
- billing 探测不会跟随 dashboard 自动刷新反复触发；只有点击“余额”“刷新余额”或调用接口时才会请求上游账单接口。
- billing 探测如果遇到 HTML 登录页或 Cloudflare/browser challenge，会标记为 `blocked`，避免误判成普通鉴权错误。
- 自动推断到的超大 `hard_limit_usd` / `system_hard_limit_usd` 会按占位上限处理，不再显示成 `USD 100M`，也不再用于推导假余额；可信的 `used_amount` 仍会保留。
- 支持 New API/AnyRouter quota 余额读取：可通过 `headers_env` 从环境变量注入网页登录态 cookie 和 `New-API-User`，再用 `data.quota / quota_per_unit` 展示真实余额。

### Dashboard

- 顶部概览新增 `Balance` 和 `Spent`。
- 每张站点卡片新增 `Billing`、`Balance`、`Spent`、`Limit`。
- 每张站点卡片新增“余额”按钮，只刷新该站点账单数据。
- 空的 `Req Left` / `Tok Left` 不再显示在卡片上；只有上游响应头真的返回 request/token 剩余额度时，才展示为 `Rate Req` / `Rate Tok`。
- 顶部概览不再显示总余额/总消费金额；金额只在每个站点卡片中展示，并使用 K/M/B/T 短单位和自适应字号避免长数字被截断。
- 顶部工具栏新增“刷新余额”按钮，用于刷新所有启用站点账单数据。
- Dashboard 新增 `AnyRouter Session` 面板，用于半自动维护登录态 cookie、New-API-User 和本地代理地址。

### 文档与测试

- README 增加 billing 与 quota/token 的区别、默认 endpoint、API 调用示例和自定义字段配置说明。
- `config.example.json` 增加全局 billing 并发/超时示例和单站点 billing 配置示例。
- smoke 测试新增 billing accounting 覆盖，验证 OpenAI-style limit/usage 解析、New API quota 余额、超大占位上限过滤、单站点状态、全局汇总和 HTML-protected billing endpoint 的 `blocked` 分类。

## 2026-06-07 17:55 CST

本次更新新增站点级 token 消耗统计，并把结果接入状态接口、dashboard 和 smoke 测试。

### Token 统计

- 成功响应会记录上游明确返回的 token 数，并按站点累计到 `stats.tokenUsage.totalTokens`。
- 每个站点会按本地日期写入 `stats.tokenUsage.byDay`，用于查看每日 token 消耗量。
- `/pool/status` 顶层新增 `usage` 汇总，包含全部站点的 `total_tokens`、`today_tokens` 和 `by_day`。
- `/pool/status.upstreams[].usage` 新增单站点 `total_tokens`、`today_tokens` 和 `by_day`。
- 最近请求记录新增 `tokens` 字段，dashboard 中会显示本次请求的 token 消耗。
- token 提取兼容未压缩 JSON 响应和 SSE 流式响应最终事件里的 usage；没有明确 usage 时不会估算。

### Dashboard

- 顶部概览新增全部站点累计 token 消耗量。
- 每张站点卡片新增 `Today Tok` 和 `Total Tok`。
- 每张站点卡片新增最近 14 天每日 token 消耗 chip，便于按天查看单站点用量。

### 文档与测试

- README 增加 token 统计字段、统计来源和边界说明。
- smoke 测试新增 token usage accounting 覆盖，验证 JSON/SSE token 提取、单站点每日/累计统计、全局汇总和最近请求 token 记录。

## 2026-06-07 17:04 CST

本次更新继续处理上一轮复查中发现的剩余高收益优化，并对 dashboard 做了一轮更偏运维工作台的视觉整理。

### 管理接口与安全

- `/health` 改为公开的最小健康响应，只返回服务可用性和 upstream 数量，不再暴露完整站点详情。
- `/pool/status` 和 `/pool/upstreams` 现在走 admin 鉴权，避免启用外部监听时泄露站点、key env 名、统计和模型列表。
- dashboard 增加 `Admin token` 输入框。启用管理接口鉴权时，可在页面输入 token，浏览器会保存到本地存储并用于后续管理请求。
- 启动日志的鉴权提示拆分为 `auth=disabled`、`auth=<ENV>:missing-deny` 和带脱敏值的已启用状态，避免 env 缺失时误判为关闭鉴权。

### Dashboard

- 顶部“重新探测全部”按钮改为直接调用 `POST /pool/probe`，使用后端统一探测逻辑和并发控制。
- 单站点“测试”按钮继续只探测当前站点。
- 每张站点卡片新增“停用/启用”开关。停用后站点仍显示在 dashboard，方便随时重新启用，但不会参与请求调度和“重新探测全部”。
- 视觉风格调整为更清爽、密集的运维工作台：降低装饰感，收紧圆角和阴影，优化卡片信息密度、指标网格、最近请求列表和移动端布局。
- 底部提示拆分为操作反馈和“最后刷新”状态，自动刷新不再覆盖刚完成的测试、保存、切换模型结果。
- 卡片里的 key 状态会随单站点探测同步更新，并按健康状态着色。
- 站点卡片补充键盘焦点样式与 Enter/Space 编辑入口，点击编辑功能在键盘下也可用。
- 卡片仍按权重从高到低展示，并保留点击卡片编辑、模型 chip 切换、签到链接等已有功能。

### CLI

- 修复 `scripts/add-upstream.mjs --replace` 未显式传 `--site-url` 时清空已有签到页的问题。
- `--replace` 默认不再重置旧 key；只有显式传 key env 时才覆盖 keys。
- `--replace` 默认不再重置旧权重；只有显式传 weight 时才覆盖 weight。

### 文档与测试

- README 增加 admin token 的 curl 示例，以及 dashboard `Admin token` 输入框说明。
- smoke 测试新增覆盖：
  - `/health` 公开且不泄露完整 upstream 列表。
  - `/pool/status` 在缺失管理/代理 token 时返回 401。
  - `/pool/upstreams/:name/enabled` 可停用/启用站点；停用站点仍在状态列表中，但不会被调度。
  - 受保护状态接口带 token 后仍能正常用于模型、站点和最近请求断言。

### 验证

已通过：

```bash
node --check src/server.mjs
node --check test/smoke-test.mjs
node --check scripts/add-upstream.mjs
npm run smoke
```

## 2026-06-07 15:55 CST

本次更新围绕 API 池的安全性、错误切站点策略、运行态保留、探测性能、CLI 能力和测试隔离做了一轮集中优化。

### 安全与鉴权

- 修复鉴权 fail-open 问题：当 `auth_token_env` 或 `admin_auth_token_env` 配置了环境变量名，但服务进程没有读到对应环境变量时，请求会被拒绝，不再默认放行。
- 保留显式关闭鉴权的能力：只有配置值为空字符串时，才表示关闭对应鉴权层。

### 错误切站点与模型保持

- 默认可切站点错误码扩展为：
  `400, 401, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504, 521, 522, 523, 524`。
- 新增 `retry.retryable_statuses` 配置项，可按需覆盖默认可重试状态码。
- 切换下一个站点时保持同一个模型，不再把失败站点的模型切换成下游站点自己的其他模型。
- 最近请求记录现在会记录最终 `all upstream attempts failed` 结果，便于在 dashboard 中看到整体失败而不只是单次 retry。

### 状态统计与运行态保留

- 修复 4xx 被误当作成功恢复的问题：现在只有 2xx/3xx 会调用成功统计，4xx/5xx 会记录为失败。
- 编辑或替换站点时，保留同名且 base URL 未变化站点的运行态信息，包括统计、quota、模型缓存、健康状态和冷却状态。
- 替换站点时，如果请求没有显式提供 `site_url`、`health_path`、`probe_auth`、`probe_headers` 或 keys，会继承旧配置，避免网页编辑时丢失高级探测设置。
- 避免在热更新时复制旧对象的 `inFlight`，防止正在进行的旧请求结束后新对象并发数卡住。

### 探测与持久化性能

- `stats.local.json` 写入改为去抖合并，减少请求路径上的同步写文件次数。
- 服务关闭时会 flush 待写入统计，降低统计丢失概率。
- 健康探测增加并发限制，默认 `health.concurrency = 4`，避免站点较多时同时打满所有 `/models` 请求。

### CLI 与文档

- `scripts/add-upstream.mjs` 增强参数支持：
  - `--site-url URL`
  - `--replace`
  - `--pool-url URL`
  - `--token-env ENV`
- `config.example.json` 增加 `retry.retryable_statuses` 和 `health.concurrency` 示例。
- `README.md` 同步更新 smoke 输出、可重试错误码、鉴权行为、单卡片测试按钮、CLI 新参数和探测并发配置。

### 测试

- smoke 测试新增覆盖：
  - 鉴权环境变量缺失时拒绝代理请求。
  - 上游 400 后切换到下一个站点，并保持原模型。
  - 522 Cloudflare 错误后切换站点，并保持同一模型。
  - 编辑站点时保留 `site_url` 和模型缓存。
  - Anthropic 风格 `/v1/models` 探测配置在替换站点时不会丢失。
- smoke 测试改为使用临时 stats 文件，避免污染真实 `stats.local.json`。

### 验证

已通过：

```bash
node --check src/server.mjs
node --check test/smoke-test.mjs
node --check scripts/add-upstream.mjs
npm run smoke
```

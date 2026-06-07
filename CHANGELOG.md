# 更新日志

## 2026-06-07 18:26 CST

本次更新修复“只能看到 quota/token，无法查看具体余额和已消费金额”的问题，新增独立 billing 探测能力。

### Billing

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
- 支持 AnyRouter Credits API（`/api/v1/credits`）读取真实 `balance` / `used`；any 站点默认优先使用 `ANY_MANAGEMENT_API_KEY`，缺少管理 key 时页面会提示 `需管理Key`。

### Dashboard

- 顶部概览新增 `Balance` 和 `Spent`。
- 每张站点卡片新增 `Billing`、`Balance`、`Spent`、`Limit`。
- 每张站点卡片新增“余额”按钮，只刷新该站点账单数据。
- 空的 `Req Left` / `Tok Left` 不再显示在卡片上；只有上游响应头真的返回 request/token 剩余额度时，才展示为 `Rate Req` / `Rate Tok`。
- 顶部概览不再显示总余额/总消费金额；金额只在每个站点卡片中展示，并使用 K/M/B/T 短单位和自适应字号避免长数字被截断。
- 顶部工具栏新增“刷新余额”按钮，用于刷新所有启用站点账单数据。

### 文档与测试

- README 增加 billing 与 quota/token 的区别、默认 endpoint、API 调用示例和自定义字段配置说明。
- `config.example.json` 增加全局 billing 并发/超时示例和单站点 billing 配置示例。
- smoke 测试新增 billing accounting 覆盖，验证 OpenAI-style limit/usage 解析、AnyRouter-style credits 余额、超大占位上限过滤、单站点状态、全局汇总和 HTML-protected billing endpoint 的 `blocked` 分类。

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

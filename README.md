# Codex API Pool

本目录实现一个本地 OpenAI-compatible API 池代理。Codex 只连接 `127.0.0.1:8787`，代理在背后自动选择可用 API 站点和 key。

## 能解决什么

- 上游 API 站点不稳定时，自动切换到另一个站点。
- 某个 key 触发 `429`、`401`、`403` 或连续失败时，进入冷却。
- 对 `400`、`401`、`403`、`404`、`408`、`409`、`425`、`429`、`5xx`、Cloudflare `521`-`524`、网络错误、超时进行切站点重试。
- 保持 `/v1/responses`、`/v1/models` 等路径形式，适配 Codex 的 `wire_api = "responses"`。

## 重要边界

代理会在上游开始返回响应之前做重试和切换。一旦上游已经返回 `200` 并开始流式输出，代理会直接转发该流；如果这时上游中途断流，无法无损续接同一个生成，只能让当前 Codex turn 失败或由 Codex 重新发起。

## 文件

- `src/server.mjs`: 本地代理服务。
- `config.local.json`: 你的本地池配置，不包含明文 key，只引用环境变量。
- `config.example.json`: 示例配置。
- `test/smoke-test.mjs`: 本地失败切换烟测。

## 环境变量

推荐使用两层令牌，职责完全分开：

```bash
# Codex -> 本地代理，只用于进入本地池，不转发给上游
export CODEX_POOL_API_KEY="本地代理访问令牌"

# 本地代理 -> 各个上游站点，只发给对应站点
export RAWCHAT_API_KEY="rawchat 的 key"
export SUB2API_API_KEY="sub2api 的 key"
export BLACK_API_KEY="black 的 key"
```

如果某个上游 key 没设置，该站点会在检测网站里显示 `missing_key`，不会参与正常调度。

新增站点时也建议给它单独的环境变量，例如：

```bash
export MYSITE_API_KEY="mysite 的 key"
npm run add -- mysite https://example.com/v1 2 MYSITE_API_KEY
```

## 启动

```bash
cd /Users/slizm/Desktop/脚本/codex-api-pool
npm run start
```

不想依赖 npm 脚本也可以直接：

```bash
node /Users/slizm/Desktop/脚本/codex-api-pool/src/server.mjs
```

启动后查看状态：

```bash
curl -s http://127.0.0.1:8787/pool/status
```

如果启用了 `admin_auth_token_env`，需要带上管理 token：

```bash
curl -s http://127.0.0.1:8787/pool/status \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY"
```

## Codex 配置

把 `~/.codex/config.toml` 顶部改成：

```toml
model = "gpt-5.5"
model_reasoning_effort = "medium"
model_provider = "api_pool"

[model_providers.api_pool]
name = "Local Codex API Pool"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
env_key = "CODEX_POOL_API_KEY"
```

原来的 `[model_providers.custom]`、`[model_providers.sub2codex]`、`[model_providers.blackandwhilt]` 可以先保留，方便手动回退；只要 `model_provider = "api_pool"`，Codex 就会走本地池。

## 调整权重

`config.local.json` 中：

```json
{ "name": "rawchat", "weight": 3 }
```

权重越高越优先。某个站点坏掉会自动熔断，冷却后再尝试恢复。

## 自测

```bash
cd /Users/slizm/Desktop/脚本/codex-api-pool
npm run smoke
```

看到下面输出说明失败切换正常：

```text
smoke ok: auth guard, fallback, upstream enable toggle, token usage accounting, billing accounting, billing huge-limit guard, billing blocked detection, runtime add, config-preserving edit, model discovery, anthropic model probe, model override, 400/522 site fallback, recent requests, and immediate health probe all passed
```

## 主动添加新站点

代理运行后，可以不重启直接添加新站点：

```bash
cd /Users/slizm/Desktop/脚本/codex-api-pool
npm run add -- mysite https://example.com/v1 2 MY_SITE_API_KEY --site-url https://example.com
```

参数含义：

- `mysite`: 站点名称，只能包含字母、数字、点、下划线、短横线。
- `https://example.com/v1`: 上游 base URL。
- `2`: 权重，越高越优先。
- `MY_SITE_API_KEY`: 存放该站点 key 的环境变量名。
- `--site-url`: 可选，站点签到页。
- `--replace`: 可选，替换同名站点。
- `--pool-url`: 可选，管理接口地址，默认 `http://127.0.0.1:8787`。
- `--token-env`: 可选，管理接口 Bearer token 的环境变量名，默认 `CODEX_POOL_API_KEY`。

添加成功后会自动写入 `config.local.json`，并立刻执行一次健康探测。

也可以直接用 HTTP 管理接口：

```bash
curl -s -X POST http://127.0.0.1:8787/pool/upstreams \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "mysite",
    "base_url": "https://example.com/v1",
    "weight": 2,
    "keys": [{ "env": "MY_SITE_API_KEY" }]
  }'
```

不推荐在接口里传 `{ "value": "sk-..." }`，因为这会把 key 明文写入 `config.local.json`。更安全的方式是传 `{ "env": "MY_SITE_API_KEY" }`。

## 自动检测每个站点

默认配置：

```json
  "health": {
    "enabled": true,
    "interval_ms": 60000,
    "timeout_ms": 10000,
    "concurrency": 4,
    "path": "/models"
  }
```

代理会定时请求每个站点的 `/models`，并在状态里显示：

- `health.state`: `ok`、`auth_error`、`rate_limited`、`server_error`、`network_error`、`timeout`、`models_unsupported` 等。
- `health.http_status`: 探测 HTTP 状态码。
- `health.latency_ms`: 探测延迟。
- `health.models_count`: 如果 `/models` 返回标准模型列表，会显示模型数量。
- `cooldown_ms`: 当前站点或 key 还要冷却多久。

查看完整状态：

```bash
curl -s http://127.0.0.1:8787/pool/status \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY"
```

立即探测某个站点：

```bash
curl -s -X POST http://127.0.0.1:8787/pool/upstreams/rawchat/probe \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY"
```

临时停用某个站点：

```bash
curl -s -X POST http://127.0.0.1:8787/pool/upstreams/rawchat/enabled \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

重新启用时把 `enabled` 改成 `true`。停用后的站点仍会出现在状态接口和检测网站中，但不会参与请求调度，也不会被“重新探测全部”命中。

## 站点数量

站点数量不做硬编码限制。你可以随时通过 `npm run add -- ...` 或 `POST /pool/upstreams` 添加新站点；代理会把新站点追加到 `config.local.json`，并立即纳入后续请求调度和健康探测。

实际可添加数量只受本机资源、探测频率、上游超时时间影响。如果站点很多，建议适当调大健康检查间隔，例如：

```json
"health": {
  "enabled": true,
  "interval_ms": 120000,
  "timeout_ms": 10000,
  "path": "/models"
}
```

## 管理接口鉴权

默认情况下，代理只监听 `127.0.0.1`，并将：

```json
"admin_auth_token_env": ""
```

设置为空，表示本机 `/pool/*` 管理接口不强制校验 Bearer token。这样你可以在任意本机终端随时添加站点，不会因为终端环境变量和代理进程环境变量不同而 `unauthorized`。

如果你希望管理接口也强制鉴权，可以改成：

```json
"admin_auth_token_env": "CODEX_POOL_API_KEY"
```

然后重启代理。

注意：只要配置了 `auth_token_env` 或 `admin_auth_token_env`，但服务进程没有读到对应环境变量，请求会被拒绝；只有把配置值显式留空，才表示关闭该层鉴权。

## 检测网站

代理内置了一个本地检测网站：

```text
http://127.0.0.1:8787/pool/dashboard
```

页面会自动刷新，并展示每个站点的：

- 健康状态
- HTTP 状态码
- 延迟
- 模型数量
- 冷却时间
- 今日 token 消耗量
- 站点累计 token 消耗量
- 最近 14 天每日 token 消耗量
- key 环境变量是否配置
- 失败次数

也可以直接在页面底部表单添加新站点，添加后会立即探测并写入 `config.local.json`。
每张站点卡片也有单独的“测试”按钮，只会探测该站点；顶部“重新探测全部”会探测所有站点。
每张站点卡片也有单独的“余额”按钮，只会刷新该站点的余额/已消费金额；顶部“刷新余额”会刷新所有启用站点。
页面只在每个站点卡片里展示具体金额，长金额会用 K/M/B/T 单位缩短并保留完整金额悬浮提示；`/pool/status` 仍保留顶层 billing 汇总，方便程序读取。
每张站点卡片都有“停用/启用”按钮。停用后卡片仍保留在页面中，方便重新开启，但代理不会把 Codex 请求调度到该站点。
如果启用了管理接口鉴权，在页面右上角的 `Admin token` 输入框填入对应 token 后，页面会把 token 保存在浏览器本地存储中用于后续请求。

## 手动检测模式

如果配置中：

```json
"health": {
  "enabled": false,
  "interval_ms": 60000,
  "timeout_ms": 10000,
  "path": "/models"
}
```

代理不会定时探测上游。需要检测时手动触发：

检测全部站点：

```bash
curl -s -X POST http://127.0.0.1:8787/pool/probe \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY"
```

检测单个站点：

```bash
curl -s -X POST http://127.0.0.1:8787/pool/upstreams/rawchat/probe \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY"
```

检测网站里的“重新探测全部”按钮也是调用 `POST /pool/probe`。

## 调用、额度与 token 统计

状态接口和检测网站会显示每个站点的统计信息：

- `stats.attempts`: 真实打到该上游的请求尝试次数。
- `stats.responses`: 收到响应的次数。
- `stats.successes`: HTTP 2xx/3xx 次数。
- `stats.failures`: HTTP 4xx/5xx 或失败响应次数。
- `stats.retries`: 因失败而被代理重试/切换的次数。
- `usage.today_tokens`: 该站点今天的 token 消耗量。
- `usage.total_tokens`: 该站点累计 token 消耗量。
- `usage.by_day`: 该站点按日期聚合的 token 消耗量。
- `billing.balance_amount`: 该站点余额。
- `billing.used_amount`: 该站点已消费金额，默认是本月截至今天的账单区间。
- `billing.limit_amount`: 该站点账单上限/授信额度。
- `billing.currency`: 金额币种。
- `quota`: 从上游响应头解析到的剩余额度信息。

`/pool/status` 顶层还会返回所有站点汇总后的：

- `usage.total_tokens`: 全部站点累计 token 消耗量。
- `usage.today_tokens`: 全部站点今天的 token 消耗量。
- `usage.by_day`: 全部站点按日期聚合后的 token 消耗量。

token 统计来自上游响应里的 `usage.total_tokens`、`input_tokens + output_tokens`、`prompt_tokens + completion_tokens`，或常见 token usage 响应头。未压缩的 JSON 响应和 SSE 流式响应里最终事件携带的 usage 都会被统计；压缩响应或未返回 usage 的站点会显示为 `0`/未知，不会估算。

余额/已消费金额来自独立的 billing 探测，不会跟随页面自动刷新反复请求上游；只有点击“余额”“刷新余额”或调用下面接口时才会刷新：

```bash
curl -s -X POST http://127.0.0.1:8787/pool/upstreams/rawchat/billing \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY"

curl -s -X POST http://127.0.0.1:8787/pool/billing \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY"
```

默认会在站点 origin 和 `base_url` 两个位置尝试 OpenAI-compatible 常见账单接口：

```text
/dashboard/billing/subscription
/dashboard/billing/usage?start_date={start_date}&end_date={end_date}
```

例如 `base_url` 是 `https://example.com/v1` 时，会先尝试 `https://example.com/dashboard/billing/...`，如果该路径失败，也会尝试 `https://example.com/v1/dashboard/billing/...`。any 这类把 billing 挂在 `/v1` 下的站点需要后者。

其中 `total_usage` 默认按 cents 处理，例如 `1234` 显示为 `USD12.34`；`hard_limit_usd`、`balance`、`spent_amount` 等明确金额字段按原金额处理。

很多中转站会把 `hard_limit_usd` / `system_hard_limit_usd` 固定返回为 `100000000`，用于表示不限额或内部占位。代理默认会把自动推断到的超大 limit 当作占位值忽略，不会显示为 `USD 100M`，也不会用它推导余额；仍会保留可信的 `used_amount`。

如果某个站点公开了独立的 credits/wallet API，也可以用 `credits_base_url` 和 `credits_path` 显式配置；没有公开 API 时，代理不会使用浏览器登录态或 cookie 去抓网页余额。

如果某个站点使用自定义接口，可以在对应 upstream 里配置：

```json
"billing": {
  "enabled": true,
  "base_url": "https://example.com",
  "subscription_path": "/api/billing",
  "credits_base_url": "https://example.com",
  "credits_path": "/api/credits",
  "credits_key_env": "EXAMPLE_MANAGEMENT_API_KEY",
  "usage_path": "",
  "currency": "USD",
  "balance_field": "data.balance",
  "used_field": "data.used_amount",
  "limit_field": "data.limit",
  "amount_unit": "usd",
  "large_limit_threshold": 10000000,
  "trust_large_limits": false
}
```

如果站点只返回自己的点数、quota 单位或必须登录网页 cookie 才能查余额，代理不会把它猜成金额。需要该站点提供 API-key 可访问的 billing JSON，或者在 `billing` 中显式配置字段和单位。

如果账单路径返回的是 HTML 登录页、Cloudflare challenge 或其他浏览器防护页面，billing 状态会显示为 `blocked`。这种情况下模型接口可能仍然可用，但代理无法只凭 API key 读取具体余额。

quota 依赖上游是否返回响应头。代理会识别常见字段：

```text
x-ratelimit-remaining-requests
x-ratelimit-remaining-tokens
x-ratelimit-limit-requests
x-ratelimit-limit-tokens
x-ratelimit-reset-requests
x-ratelimit-reset-tokens
x-quota-remaining
x-remaining-quota
x-api-quota-remaining
retry-after
```

如果上游不返回这些 header，剩余额度会保持未知，不会编造数值。dashboard 会隐藏空的 request/token header quota，避免把它误看成余额字段。

## 可重试错误码

默认会对常见上游错误切换到下一个站点，并保持同一个模型不变。需要调整时可在配置里覆盖：

```json
"retry": {
  "retryable_statuses": [400, 401, 403, 404, 408, 409, 425, 429, 500, 502, 503, 504, 521, 522, 523, 524]
}
```

如果你发现某个站点经常用特殊状态码表示临时失败，可以把该状态码加进这个列表。

统计会持久化到：

```text
/Users/slizm/Desktop/脚本/codex-api-pool/stats.local.json
```

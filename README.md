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
smoke ok: auth guard, fallback, runtime add, config-preserving edit, model discovery, anthropic model probe, model override, 400/522 site fallback, recent requests, and immediate health probe all passed
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
curl -s http://127.0.0.1:8787/pool/status
```

立即探测某个站点：

```bash
curl -s -X POST http://127.0.0.1:8787/pool/upstreams/rawchat/probe \
```

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
- key 环境变量是否配置
- 失败次数

也可以直接在页面底部表单添加新站点，添加后会立即探测并写入 `config.local.json`。
每张站点卡片也有单独的“测试”按钮，只会探测该站点；顶部“重新探测全部”会探测所有站点。

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
curl -s -X POST http://127.0.0.1:8787/pool/probe
```

检测单个站点：

```bash
curl -s -X POST http://127.0.0.1:8787/pool/upstreams/rawchat/probe
```

检测网站里的“重新探测全部”按钮也是调用 `POST /pool/probe`。

## 调用次数与剩余额度统计

状态接口和检测网站会显示每个站点的统计信息：

- `stats.attempts`: 真实打到该上游的请求尝试次数。
- `stats.responses`: 收到响应的次数。
- `stats.successes`: HTTP 2xx/3xx 次数。
- `stats.failures`: HTTP 4xx/5xx 或失败响应次数。
- `stats.retries`: 因失败而被代理重试/切换的次数。
- `quota`: 从上游响应头解析到的剩余额度信息。

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

如果上游不返回这些 header，剩余额度会显示为空/未知，不会编造数值。

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

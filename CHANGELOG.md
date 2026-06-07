# 更新日志

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

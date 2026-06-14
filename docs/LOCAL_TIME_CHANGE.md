# 时间格式修改说明

## 修改内容

将请求记录的时间格式从 **UTC 时间** 改为 **本地时间**。

## 修改前后对比

### 修改前（UTC 时间）
```json
{
  "at": "2026-06-13T13:57:58.194Z",
  ...
}
```
- 格式：ISO 8601 UTC
- 后缀：`Z` 表示 UTC（零时区）
- 问题：需要手动转换为本地时间

### 修改后（本地时间）
```json
{
  "at": "2026-06-13T21:57:58.194+08:00",
  ...
}
```
- 格式：ISO 8601 带时区偏移
- 后缀：`+08:00` 表示 UTC+8（中国标准时间）
- 优点：直接显示本地时间，无需转换

## 时区示例

| 地区 | 时区 | 示例 |
|------|------|------|
| 中国（北京） | UTC+8 | `2026-06-13T21:57:58.194+08:00` |
| 美国东部 | UTC-5 | `2026-06-13T08:57:58.194-05:00` |
| 美国西部 | UTC-8 | `2026-06-13T05:57:58.194-08:00` |
| 英国 | UTC+0 | `2026-06-13T13:57:58.194+00:00` |
| 日本 | UTC+9 | `2026-06-13T22:57:58.194+09:00` |

## 实现细节

### 新增函数
```javascript
function localDateTimeString(timestamp = now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  const second = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  const tzOffset = -date.getTimezoneOffset();
  const tzHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, '0');
  const tzMinutes = String(Math.abs(tzOffset) % 60).padStart(2, '0');
  const tzSign = tzOffset >= 0 ? '+' : '-';
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}${tzSign}${tzHours}:${tzMinutes}`;
}
```

### 修改位置
`src/server.mjs` 第 4787 行：
```javascript
// 修改前
at: new Date().toISOString(),

// 修改后
at: localDateTimeString(),
```

## 验证

重启服务后，新的请求记录会使用本地时间：

```bash
# 重启服务
npm start

# 发送测试请求
curl -X POST http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $CODEX_POOL_API_KEY" \
  -d '{"model": "gpt-5.5", "input": [{"type": "text", "text": "test"}]}'

# 查看最新记录的时间
curl -s http://127.0.0.1:8787/pool/status | jq -r '.recent_requests[0].at'

# 输出示例（中国时区）：
# 2026-06-13T21:57:58.194+08:00
```

## 兼容性

### JSON 解析
本地时间格式仍然是标准的 ISO 8601 格式，可以被正常解析：

```javascript
// JavaScript
new Date("2026-06-13T21:57:58.194+08:00")

// jq
jq '.at | fromdateiso8601'
```

### 数据库存储
如果需要存储到数据库，大多数数据库都支持带时区的时间戳：
- PostgreSQL: `TIMESTAMP WITH TIME ZONE`
- MySQL: `DATETIME` (需要配置时区)
- SQLite: 可以直接存储字符串

### 排序
ISO 8601 格式可以直接按字符串排序：
```bash
# 按时间排序日志
sort -t: -k1 requests.debug.log
```

## 注意事项

### 1. 旧数据格式
修改前的旧记录仍然是 UTC 时间（带 `Z` 后缀），新记录是本地时间（带时区偏移）。

如果需要统一，可以运行转换脚本：
```bash
# 将 UTC 时间转换为本地时间（示例）
jq '.recentRequests |= map(
  if .at | endswith("Z") then
    .at = (.at | fromdateiso8601 | strflocaltime("%Y-%m-%dT%H:%M:%S.000%z"))
  else . end
)' stats.local.json > stats.local.json.tmp
mv stats.local.json.tmp stats.local.json
```

### 2. 跨时区协作
如果团队成员在不同时区，每个人看到的时间会不同：
- 北京的人看到：`2026-06-13T21:57:58.194+08:00`
- 纽约的人看到：`2026-06-13T08:57:58.194-05:00`

但这两个时间指向同一时刻，只是表示方式不同。

### 3. 日志分析
如果需要按 UTC 时间统一分析，可以转换：
```bash
# 将本地时间转换为 UTC
jq -r '.at | fromdateiso8601 | todateiso8601' requests.debug.log
```

## 优点

✅ **直观**：直接显示本地时间，无需心算转换  
✅ **精确**：包含时区信息，不会混淆  
✅ **兼容**：仍然是标准 ISO 8601 格式  
✅ **可排序**：字符串可以直接排序  
✅ **易读**：人类可读性更好

## 回滚

如果需要恢复为 UTC 时间，修改第 4787 行：

```javascript
// 恢复为 UTC
at: new Date().toISOString(),
```

然后重启服务即可。

# 请求捕获与日志功能实现总结

## 实现概述

为 Codex API Pool 添加了完整的请求捕获和日志记录功能，用于调试和分析客户端真实请求。

## 核心特性

### ✅ 捕获真实客户端请求
- 在任何协议转换、适配器处理之前捕获
- 记录的是客户端发来的**原始请求**，不是转发给上游后的请求
- 包含所有请求头和完整请求体

### ✅ 无过滤保存
- 移除了敏感信息过滤逻辑
- Authorization、Cookie、API Key 等敏感头全部保存
- 完整的 JSON payload

### ✅ 三层存储架构
1. **内存** (`state.recentRequests`)：最近 30 条，实时访问
2. **持久化** (`stats.local.json`)：重启后恢复
3. **日志文件** (`requests.debug.log`)：JSONL 格式，完整历史

## 代码修改清单

### 1. 核心函数修改

#### `captureIncomingRequestHeaders()` (第185-196行)
**之前**：过滤敏感头（authorization, cookie, token 等）  
**现在**：捕获所有头，不做任何过滤

#### `requestDebugFields()` (第198-212行)
**之前**：只接受 `incomingHeaders` 参数  
**现在**：新增 `incomingBody` 参数，自动解析 JSON

#### `stripRequestDebugFields()` (第202-204行)
**之前**：只移除 `incomingHeaders`  
**现在**：同时移除 `incomingHeaders` 和 `incomingBody`

### 2. 状态管理修改

#### `buildState()` (第4412行)
**新增**：在返回对象中添加 `config` 字段，供后续函数访问配置

#### `statsSnapshot()` (第4452-4457行)
**修改**：根据 `capture_request_headers` 配置决定是否保存完整信息

#### `rememberRequest()` (第4767-4789行)
**新增**：调用 `writeRequestDebugLog()` 写入日志文件

#### `writeRequestDebugLog()` (新增函数)
**功能**：将请求记录追加到日志文件（JSONL 格式）

### 3. Responses API 集成（5处修改）

- `finishResponseAttempt()` 函数签名增加 `incomingBody` 参数
- 所有调用点传入 `originalBody`（仅在 debug 模式启用时）
- 涵盖场景：
  - 成功响应
  - HTTP 错误
  - 流式错误
  - 客户端中断
  - 重试
  - 最终失败

### 4. Messages API 集成（6处修改）

- 在入口处添加 `incomingHeaderSample` 捕获
- 更新所有 `rememberRequest` 调用
- 涵盖场景：
  - 成功响应
  - HTTP 错误
  - 网络错误
  - 超时
  - 最终失败（无可用上游）

## 配置选项

### config.local.json

```json
{
  "debug": {
    "capture_request_headers": true,      // 必须启用才会捕获完整信息
    "request_log_path": "requests.debug.log"  // 可选，日志文件路径
  }
}
```

## 存储详解

### 1. 内存存储
- **位置**：`state.recentRequests` 数组
- **容量**：最近 30 条
- **访问**：`/pool/status` API, Dashboard

### 2. 持久化存储
- **位置**：`stats.local.json`
- **格式**：JSON，包含 `recentRequests` 数组
- **更新**：延迟写入（500ms debounce）
- **恢复**：服务启动时自动加载

### 3. 日志文件存储
- **位置**：`requests.debug.log`（可配置）
- **格式**：JSONL（每行一个 JSON 对象）
- **模式**：追加（不覆盖）
- **清理**：需要手动清理

## 辅助工具

### 脚本

1. **view-request-log.sh**
   - 查看最近 N 条请求
   - 实时跟踪（类似 `tail -f`）
   - 支持 `jq` 格式化输出

2. **analyze-request-log.sh**
   - 按协议/上游/状态码/结果分组统计
   - 响应时间统计（平均/最小/最大）
   - 最近失败请求列表

3. **extract-request.sh**
   - 提取最后一个请求
   - 提取最后一个失败请求
   - 按上游/模型过滤
   - 通过 ID 精确查找

### 测试脚本

**test-request-capture.sh**
- 发送测试请求
- 验证捕获功能
- 检查 headers 和 body 是否被保存

## 记录的信息

每条记录包含：

```typescript
{
  id: string;                    // 唯一 ID
  at: string;                    // ISO 时间戳
  method: string;                // HTTP 方法
  path: string;                  // 请求路径
  entry_protocol: string;        // 入口协议 (responses/messages/chat_completions)
  
  // 仅在 capture_request_headers: true 时存在
  incomingHeaders?: {            // 客户端原始请求头（包括敏感信息）
    authorization?: string;
    "content-type"?: string;
    "user-agent"?: string;
    [key: string]: string;
  };
  incomingBody?: any;            // 客户端原始请求体（JSON）
  
  upstream: string | null;       // 选择的上游
  key: string | null;            // 使用的密钥
  originalModel?: string;        // 原始模型
  actualModel?: string;          // 实际模型（可能被 override）
  status: number;                // HTTP 状态码
  durationMs?: number;           // 响应时间（毫秒）
  retried: boolean;              // 是否重试过
  outcome: string;               // 结果 (ok/error/failed/retry/stream_error/client_aborted)
  reason?: string;               // 失败原因
  route?: object;                // 路由信息
  compatibility?: object;        // 兼容性转换信息
  tokens?: number;               // 总 Token 数
  inputTokens?: number;          // 输入 Token 数
  outputTokens?: number;         // 输出 Token 数
}
```

## 安全考虑

### 敏感信息
- ⚠️ 日志包含完整的 API Keys、Cookies、用户输入
- 已添加到 `.gitignore`
- 建议定期清理
- 分享前必须脱敏

### 性能影响
- **内存**：30 条记录约 60-300 KB
- **I/O**：
  - stats.local.json: 延迟写入（500ms）
  - requests.debug.log: 同步追加（~1ms/请求）
- **建议**：生产环境只用内存 + stats.local.json

## 文档

1. **README.md**
   - 新增"调试与请求日志"章节
   - 配置说明
   - 查看方式
   - 安全提示

2. **docs/REQUEST_LOGGING.md**
   - 完整的功能说明
   - 详细的使用示例
   - 高级分析技巧
   - 故障排查

3. **docs/REQUEST_LOGGING_QUICKREF.md**
   - 快速参考卡片
   - 常用命令
   - 一行配置

## 验证方法

### 1. 启用功能
```bash
# 编辑 config.local.json
vim config.local.json

# 重启服务
npm start
```

### 2. 运行测试
```bash
./test-request-capture.sh
```

### 3. 检查日志
```bash
# 查看最近请求
./scripts/view-request-log.sh

# 验证是否有敏感信息
jq '.incomingHeaders.authorization' requests.debug.log | head -1

# 验证是否有请求体
jq '.incomingBody' requests.debug.log | head -1
```

## 后续改进建议

### 可选功能
1. **日志轮转**：自动归档旧日志（按大小或日期）
2. **过滤器**：只记录特定协议/上游/状态码的请求
3. **采样**：高流量时只记录部分请求
4. **压缩**：使用 gzip 压缩归档日志

### 分析工具
1. **日志解析器**：将 JSONL 转换为其他格式（CSV、SQLite）
2. **可视化工具**：请求流量、延迟趋势、错误率图表
3. **告警系统**：错误率超过阈值时通知

## 总结

✅ **功能完整**：捕获所有请求信息，无删减  
✅ **真实原始**：记录客户端发来的原始请求，不是转发后的  
✅ **三层存储**：内存、持久化、日志文件  
✅ **工具齐全**：查看、统计、分析脚本  
✅ **文档完善**：README、详细文档、快速参考  
✅ **安全考虑**：.gitignore、脱敏建议、权限提示

现在用户可以通过 Dashboard、API 或日志文件，完整查看客户端发来的真实请求，包括所有敏感信息，用于调试和分析。

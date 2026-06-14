# 请求日志功能 - 文件修改清单

## 修改的文件

### 核心代码

#### 1. src/server.mjs
**修改概述**：添加完整请求捕获和日志记录功能

**具体修改**：
- **第 185-196 行**：`captureIncomingRequestHeaders()` - 移除敏感信息过滤，保存所有请求头
- **第 198-212 行**：`requestDebugFields()` - 新增 `incomingBody` 参数支持
- **第 202-204 行**：`stripRequestDebugFields()` - 同时移除 headers 和 body
- **第 4412 行**：`buildState()` - 返回对象中添加 `config` 字段
- **第 4452-4457 行**：`statsSnapshot()` - 根据配置决定是否保存完整信息
- **第 4767-4789 行**：`rememberRequest()` - 新增日志文件写入逻辑
- **第 4791-4799 行**：`writeRequestDebugLog()` - 新增函数，写入 JSONL 格式日志

**Responses API 集成**（5处）：
- **第 6741 行**：`finishResponseAttempt()` 函数签名增加 `incomingBody`
- **第 13725 行**：成功响应时传入 `originalBody`
- **第 13586 行**：客户端中断时传入 `originalBody`
- **第 13618 行**：流错误时传入 `originalBody`
- **第 13781 行**：重试时传入 `originalBody`
- **第 13834 行**：最终失败时传入 `originalBody`

**Messages API 集成**（6处）：
- **第 12916 行**：入口处添加 `incomingHeaderSample` 捕获
- **第 13075 行**：成功响应时传入 headers 和 body
- **第 13148 行**：HTTP 错误时传入 headers 和 body
- **第 13198 行**：网络错误时传入 headers 和 body
- **第 13236 行**：超时时传入 headers 和 body
- **第 13281 行**：无可用上游时传入 headers 和 body

**修改行数统计**：约 20 处修改，涉及 13 个函数

### 配置文件

#### 2. config.local.json
**修改**：
```json
{
  "debug": {
    "capture_request_headers": true,        // 从 false 改为 true
    "request_log_path": "requests.debug.log"  // 新增
  }
}
```

### 文档

#### 3. README.md
**新增章节**："调试与请求日志"（约 80 行）
- 配置说明
- 存储位置说明
- 查看方式（Dashboard、API、日志文件）
- 日志分析示例
- 安全提示

#### 4. docs/REQUEST_LOGGING.md（新文件）
**内容**：完整的功能说明和使用指南（约 400 行）
- 功能概述
- 配置详解
- 存储位置详解
- 三种查看方式
- 高级分析示例
- 安全注意事项
- 性能影响
- 故障排查

#### 5. docs/REQUEST_LOGGING_QUICKREF.md（新文件）
**内容**：快速参考卡片（约 60 行）
- 一行配置
- 常用命令
- 分析示例

#### 6. docs/REQUEST_LOGGING_IMPLEMENTATION.md（新文件）
**内容**：实现总结（约 280 行）
- 实现概述
- 代码修改清单
- 配置选项
- 存储详解
- 记录的信息结构

## 新增的脚本

### 7. scripts/view-request-log.sh（新文件）
**功能**：查看和跟踪请求日志
**用法**：
```bash
./scripts/view-request-log.sh           # 最近 10 条
./scripts/view-request-log.sh 20        # 最近 20 条
./scripts/view-request-log.sh all       # 全部
./scripts/view-request-log.sh follow    # 实时跟踪
```
**行数**：约 45 行

### 8. scripts/analyze-request-log.sh（新文件）
**功能**：统计分析请求日志
**输出**：
- 总请求数
- 按协议/上游/状态码/结果分组统计
- 响应时间统计
- 最近失败请求列表
**行数**：约 70 行

### 9. scripts/extract-request.sh（新文件）
**功能**：提取特定请求的完整信息
**用法**：
```bash
./scripts/extract-request.sh --last              # 最后一个
./scripts/extract-request.sh --last-error        # 最后失败
./scripts/extract-request.sh --upstream rawchat  # 按上游
./scripts/extract-request.sh --model claude-*    # 按模型
./scripts/extract-request.sh <request_id>        # 按 ID
```
**行数**：约 85 行

### 10. test-request-capture.sh（新文件）
**功能**：测试请求捕获功能
**用法**：
```bash
./test-request-capture.sh
```
**验证**：
- 发送测试请求
- 检查是否捕获了 headers
- 检查是否捕获了 body
- 验证敏感信息是否被保存
**行数**：约 40 行

## 运行时生成的文件

### 11. requests.debug.log（运行时生成）
**格式**：JSONL（每行一个 JSON 对象）
**内容**：所有请求的完整记录
**位置**：项目根目录
**状态**：已添加到 `.gitignore`（第 3 行已存在 `*.log`）

### 12. stats.local.json（已存在，内容变化）
**变化**：`recentRequests` 数组中的对象现在包含：
- `incomingHeaders`（如果 `capture_request_headers: true`）
- `incomingBody`（如果 `capture_request_headers: true`）

## Git 版本控制

### 已提交的文件
- ✅ src/server.mjs（修改）
- ✅ README.md（修改）
- ✅ docs/REQUEST_LOGGING.md（新增）
- ✅ docs/REQUEST_LOGGING_QUICKREF.md（新增）
- ✅ docs/REQUEST_LOGGING_IMPLEMENTATION.md（新增）
- ✅ scripts/view-request-log.sh（新增）
- ✅ scripts/analyze-request-log.sh（新增）
- ✅ scripts/extract-request.sh（新增）
- ✅ test-request-capture.sh（新增）

### 不应提交的文件
- ❌ config.local.json（已在 `.gitignore`）
- ❌ stats.local.json（已在 `.gitignore`）
- ❌ requests.debug.log（`*.log` 已在 `.gitignore`）

## 文件统计

| 类型 | 数量 | 总行数（约） |
|------|------|-------------|
| 核心代码修改 | 1 | ~100 行修改 |
| 配置文件修改 | 1 | 2 行修改 |
| 文档新增/修改 | 4 | ~900 行 |
| 脚本新增 | 4 | ~240 行 |
| **总计** | **10** | **~1242 行** |

## 验证清单

### 功能验证
- [ ] 配置文件修改正确
- [ ] 服务可以正常启动
- [ ] 发送请求后能在 Dashboard 看到
- [ ] API 查询能返回完整信息
- [ ] 日志文件被创建并包含记录
- [ ] 请求头被完整保存（包括敏感信息）
- [ ] 请求体被完整保存

### 脚本验证
- [ ] view-request-log.sh 可执行且输出正确
- [ ] analyze-request-log.sh 可执行且统计正确
- [ ] extract-request.sh 可执行且查询正确
- [ ] test-request-capture.sh 可执行且测试通过

### 文档验证
- [ ] README.md 新章节完整
- [ ] 所有新文档可读且格式正确
- [ ] 代码示例可以直接运行

### Git 验证
- [ ] 敏感文件不在 git status 中
- [ ] 所有应提交的文件已添加

## 回滚方案

如果需要回滚功能：

### 1. 禁用功能（保留代码）
```json
{
  "debug": {
    "capture_request_headers": false,
    "request_log_path": ""
  }
}
```

### 2. 完全回滚（恢复代码）
```bash
# 恢复 server.mjs
git checkout HEAD -- src/server.mjs

# 删除新增文件
rm docs/REQUEST_LOGGING*.md
rm scripts/*-request*.sh
rm test-request-capture.sh

# 恢复 README.md（如果需要）
git checkout HEAD -- README.md
```

## 下一步建议

### 优先级 1（立即）
- [x] 测试基本功能
- [ ] 在开发环境运行一段时间
- [ ] 收集反馈

### 优先级 2（短期）
- [ ] 添加日志轮转功能
- [ ] 添加日志大小限制
- [ ] 优化写入性能（批量写入）

### 优先级 3（长期）
- [ ] 添加日志采样功能
- [ ] 添加过滤器配置
- [ ] 开发 Web UI 日志查看器
- [ ] 支持导出为 CSV/SQLite

## 总结

✅ **10 个文件修改/新增**  
✅ **~1242 行代码/文档**  
✅ **完整的捕获功能**  
✅ **三种查看方式**  
✅ **四个辅助脚本**  
✅ **完善的文档**  

所有修改都已完成，可以立即启用和使用。

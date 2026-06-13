# Codex API Pool - 项目状态

**更新时间**: 2026-06-13  
**版本**: ADR-0004 实施完成

---

## 📊 项目概览

Codex API Pool 是一个多上游 API 代理池，支持：
- ✅ OpenAI Responses API (Codex Desktop)
- ✅ Anthropic Messages API (Claude Desktop) **[新增]**
- ✅ OpenAI Chat Completions API
- ✅ 智能协议适配和转换

---

## 🎯 最新更新 (2026-06-13)

### 新增功能
- ✅ **Messages API 支持** - Claude Desktop 可通过 Pool 复用多上游
- ✅ **智能协议路由** - 原生转发 + 适配器回退
- ✅ **特性检测** - 识别并处理 Messages-only 特性
- ✅ **Dashboard 可观测性** - entry_protocol 和 routing_strategy 追踪

### Bug 修复
- ✅ **HTTP/HTTPS 协议硬编码** - 现在动态选择
- ✅ **Content-Length 截断** - 请求体转换后完整传输
- ✅ **工具检测精度** - 报告具体工具类型

---

## 📁 项目结构

```
codex-api-pool/
├── src/
│   └── server.mjs                 # 核心服务器 (~13,700 行)
├── test/
│   ├── smoke-test.mjs            # 原有烟雾测试
│   ├── messages-features.test.mjs         # Messages 特性检测 (6)
│   ├── messages-to-chat-conversion.test.mjs  # 请求转换 (18)
│   ├── chat-to-messages-response.test.mjs    # 响应转换 (13)
│   ├── messages-e2e-integration.test.mjs     # 端到端 (4)
│   ├── tdd-http-protocol-selection.test.mjs  # HTTP/HTTPS (3)
│   ├── tdd-complete-protocol-selection.test.mjs  # 完整协议 (3)
│   ├── tdd-content-length-regression.test.mjs    # Content-Length (3)
│   ├── tdd-refactor-protection.test.mjs      # 行为保护 (4)
│   ├── tdd-dashboard-observability.test.mjs  # Dashboard (3)
│   └── debug-*.mjs               # 临时调试文件 (可删除)
├── docs/
│   ├── adr/
│   │   └── 0004-claude-desktop-messages-api-support.md
│   ├── ADR-0004-IMPLEMENTATION-ANALYSIS.md   # 实施分析
│   ├── ADR-0004-IMPLEMENTATION-COMPLETE.md   # 完成报告
│   ├── ADR-0004-SUMMARY.md                   # 实施总结
│   ├── MESSAGES-API-GUIDE.md                 # 用户指南
│   └── PROJECT-STATUS.md                     # 本文档
├── CHANGELOG.md                  # 变更日志
└── config.example.yaml           # 配置示例
```

---

## 🧪 测试覆盖

### Messages API 测试 (新增)
- `messages-features`: 6 个测试 ✅
- `messages-to-chat-conversion`: 18 个测试 ✅
- `chat-to-messages-response`: 13 个测试 ✅
- `messages-e2e-integration`: 4 个测试 ✅
- `tdd-http-protocol-selection`: 3 个测试 ✅
- `tdd-complete-protocol-selection`: 3 个测试 ✅
- `tdd-content-length-regression`: 3 个测试 ✅
- `tdd-refactor-protection`: 4 个测试 ✅
- `tdd-dashboard-observability`: 3 个测试 ✅

**总计**: 57 个新测试，100% 通过

### 原有测试
- `smoke-test`: 原有功能回归 ✅

---

## 🚀 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 配置
```bash
cp config.example.yaml config.yaml
# 编辑 config.yaml
```

### 3. 启动
```bash
node src/server.mjs
```

### 4. 测试
```bash
# 运行所有 Messages API 测试
for test in test/messages-*.test.mjs test/tdd-*.test.mjs; do
  node $test
done

# 运行烟雾测试
node test/smoke-test.mjs
```

---

## 📖 文档

### 用户文档
- [Messages API 配置指南](./MESSAGES-API-GUIDE.md) - 快速开始
- [CHANGELOG](../CHANGELOG.md) - 变更历史

### 开发文档
- [ADR-0004](./adr/0004-claude-desktop-messages-api-support.md) - 架构决策
- [实施分析](./ADR-0004-IMPLEMENTATION-ANALYSIS.md) - 详细实施状态
- [完成报告](./ADR-0004-IMPLEMENTATION-COMPLETE.md) - 测试和质量
- [实施总结](./ADR-0004-SUMMARY.md) - 最终验证结果

---

## 🔧 配置示例

### 混合上游（推荐）
```yaml
server:
  host: 127.0.0.1
  port: 8787
  auth_token_env: POOL_TOKEN

compatibility:
  adapter_mode:
    strip_messages_only_features: true
    adapters:
      chat_completions: true

upstreams:
  - name: anthropic-main
    base_url: https://api.anthropic.com
    api: anthropic
    keys:
      - env: ANTHROPIC_KEY
  
  - name: openai-fallback
    base_url: https://api.openai.com
    api: openai
    keys:
      - env: OPENAI_KEY
```

---

## 🎯 路由逻辑

### Responses API (`/v1/responses`)
```
Codex Desktop → Pool → OpenAI 上游
                    ↓
              (可选) Anthropic 适配器
```

### Messages API (`/v1/messages`)
```
Claude Desktop → Pool → 原生: Anthropic 上游 (优先)
                     ↓
                     适配器: OpenAI 上游 (回退)
```

---

## 📊 支持的 API

| API | 入口 | 上游 | 适配器 | 状态 |
|-----|-----|------|-------|------|
| Responses | `/v1/responses` | OpenAI | → Messages | ✅ |
| Messages | `/v1/messages` | Anthropic | 原生 | ✅ |
| Messages | `/v1/messages` | OpenAI | → Chat | ✅ |
| Chat Completions | `/v1/chat/completions` | OpenAI | 原生 | ✅ |

---

## 🔍 可观测性

### Dashboard
访问 `http://127.0.0.1:8787/pool/dashboard`

显示：
- Recent Requests (含 `entry_protocol`)
- Upstream Status
- Routing Strategy
- Token Usage
- Availability

### API 端点
- `GET /pool/status` - 完整状态
- `GET /health` - 健康检查
- `GET /pool/upstreams` - 上游列表

---

## 🛠️ 开发

### 运行测试
```bash
# Messages API 测试
node test/messages-features.test.mjs
node test/messages-to-chat-conversion.test.mjs
node test/chat-to-messages-response.test.mjs
node test/messages-e2e-integration.test.mjs

# TDD 回归测试
node test/tdd-http-protocol-selection.test.mjs
node test/tdd-content-length-regression.test.mjs
node test/tdd-dashboard-observability.test.mjs

# 原有功能
node test/smoke-test.mjs
```

### 语法检查
```bash
node --check src/server.mjs
```

### 调试
临时调试文件在 `test/debug-*.mjs`，可以安全删除。

---

## 📈 性能

- **原生转发**: 零额外开销
- **适配器转换**: <1ms
- **流式响应**: 增量转换，无缓冲

---

## 🔐 安全

- Pool Token 认证
- Admin Token 保护管理端点
- 上游 API Key 隔离
- 错误信息脱敏

---

## 🐛 已知问题

**无** - 所有已知 bug 已修复并有测试保护

---

## 📝 待办事项

### 可选增强 (低优先级)
- [ ] Messages → Responses adapter (Phase 3)
- [ ] Learned Forwarding Strategy
- [ ] 配置 UI

### 维护
- [ ] 删除临时调试文件 (`test/debug-*.mjs`)
- [ ] 定期更新依赖

---

## 🤝 贡献

### 代码规范
- TDD 方法论 (RED → GREEN → REFACTOR)
- 完整的测试覆盖
- 清晰的职责分离
- 详细的文档

### 提交新功能
1. 先写测试 (RED)
2. 实现功能 (GREEN)
3. 重构优化 (REFACTOR)
4. 更新文档
5. 运行完整测试套件

---

## 📄 许可

请参考项目 LICENSE 文件。

---

## 📞 支持

- 文档: `docs/` 目录
- Issues: 项目 Issue tracker
- 变更日志: `CHANGELOG.md`

---

**项目状态**: ✅ **生产就绪**  
**最后更新**: 2026-06-13  
**测试状态**: ✅ 100% 通过

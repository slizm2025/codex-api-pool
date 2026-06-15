# 协议转换字段映射参考

本文档记录 API Pool 在三种协议族之间转换时的字段映射，供协议适配实现与诊断参考。
权威的行为说明见 `CORE_FEATURES.md` §3（多协议支持与自动适配）。

涉及的转换路径：
- **Responses → Chat Completions**（无原生 Responses 上游时）
- **Responses → Anthropic Messages**（无原生 Responses 上游时）
- **Messages → Chat Completions**（无原生 Messages 上游、且启用 adapter 兼容模式时）

---

## 一、Messages → Chat Completions（请求方向）

### 消息结构

| Anthropic Messages | OpenAI Chat Completions |
| --- | --- |
| `{ role: 'user'\|'assistant', content: string \| blocks[] }` | `{ role: 'user'\|'assistant', content: string \| parts[] }` |
| `tool_use` block | `tool_calls[]`（assistant 消息） |
| `tool_result` block | `{ role: 'tool', tool_call_id, content }` 消息 |

### 内容块

| Anthropic 块 | Chat Completions 部分 |
| --- | --- |
| `{ type: 'text', text }` | `{ type: 'text', text }` |
| `{ type: 'image', source: { type: 'base64'\|'url', ... } }` | `{ type: 'image_url', image_url: { url } }` |
| `{ type: 'document', source: { type: 'base64'\|'url'\|'text', ... } }` | `{ type: 'file', file: { file_data, filename } }`（base64/url）；text source 保留为 text |
| `{ type: 'thinking', thinking }` | **剥离**（启用 strip_messages_only_features 时） |
| `{ type: 'tool_use', id, name, input }` | `tool_calls[]: { id, type: 'function', function: { name, arguments } }` |
| `{ type: 'tool_result', tool_use_id, content }` | `{ role: 'tool', tool_call_id, content }` |

### 字段映射

| Anthropic | Chat Completions |
| --- | --- |
| `system: string \| [{ type: 'text', text }]` | `messages[0] = { role: 'system', content }` |
| `tools: [{ name, description, input_schema }]` | `tools: [{ type: 'function', function: { name, description, parameters } }]` |
| `tool_choice: { type: 'auto'\|'any'\|'tool', name? }` | `'auto' \| 'required' \| { type: 'function', function: { name } }` |
| `max_tokens` | `max_completion_tokens` |
| `output_config.format.{ type: 'json_schema', json_schema }` | `response_format: { type: 'json_schema', json_schema }` |
| `temperature` / `top_p` / `stop_sequences` | `temperature` / `top_p` / `stop` |
| `metadata.user_id` | `user` |

### 被剥离的 Messages-only 特性（启用 strip_messages_only_features）
- `cache_control`（system / message / content / tool 各级）
- `thinking` 块
- Computer Use 工具（`computer_20241022`、`text_editor_20241022`、`bash_20241022`）

> 剥离通过响应头 `x-codex-api-pool-stripped` 与 Recent Request Timeline 的 `compatibility` 记录透明化。

---

## 二、Chat Completions → Messages（响应方向，用于 Messages→Chat 适配的回包）

### JSON 响应

| OpenAI Chat | Anthropic Messages |
| --- | --- |
| `id: 'chatcmpl-*'` | `id: 'msg_*'` |
| `choices[0].message.content` | `content[0]: { type: 'text', text }` |
| `choices[0].message.tool_calls[]` | `content[n]: { type: 'tool_use', id, name, input }` |
| `choices[0].finish_reason` | `stop_reason`（见下） |
| `usage: { prompt_tokens, completion_tokens, total_tokens }` | `usage: { input_tokens, output_tokens }`（无 total） |

### finish_reason 映射

| Chat Completions | Anthropic Messages |
| --- | --- |
| `stop` | `end_turn` |
| `length` | `max_tokens` |
| `tool_calls` | `tool_use` |
| `content_filter` | `stop_sequence`（近似） |

### SSE 流式状态机

| 阶段 | Anthropic 事件 |
| --- | --- |
| 流开始 | `message_start` |
| 内容块开始 | `content_block_start` |
| 内容增量 | `content_block_delta`（`text_delta` / `input_json_delta`） |
| 内容块结束 | `content_block_stop` |
| 消息结束 | `message_delta`（含 `stop_reason`） + `message_stop` |

Chat SSE（`choices[].delta`）按上述状态机转换为 Anthropic 事件序列。

---

## 三、Responses → Chat / Messages

Responses 请求的兼容转换遵循 CORE_FEATURES §3 字段映射表，分类为：
- **converted**：无损等价映射（如 `input_image` → `image_url` / `image`）
- **downgraded**：有损但可表示的弱映射（如 `web_search` → `web_search_options`）
- **stripped**：目标协议无等价字段，必须移除（如 `image_generation`、`context_management`、`previous_response_id`）

转换同样通过 `x-codex-api-pool-stripped` / `converted` / `downgraded` 响应头与 Timeline 透明化。

// Chat Completions → Messages response conversion reference
// This documents the response mappings needed for Issue #5

/*
RESPONSE FORMAT CONVERSION:

1. JSON Response:
   OpenAI Chat:
   {
     id: 'chatcmpl-123',
     object: 'chat.completion',
     created: 1234567890,
     model: 'gpt-4',
     choices: [{
       index: 0,
       message: {
         role: 'assistant',
         content: 'Hello',
         tool_calls: [...]
       },
       finish_reason: 'stop'
     }],
     usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
   }
   
   Anthropic Messages:
   {
     id: 'msg_123',
     type: 'message',
     role: 'assistant',
     content: [
       { type: 'text', text: 'Hello' },
       { type: 'tool_use', id: '...', name: '...', input: {...} }
     ],
     model: 'claude-opus-4-8',
     stop_reason: 'end_turn',
     stop_sequence: null,
     usage: { input_tokens: 10, output_tokens: 5 }
   }

2. SSE Streaming:
   OpenAI Chat:
   data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}
   data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}
   data: {"id":"chatcmpl-123","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
   data: [DONE]
   
   Anthropic Messages:
   event: message_start
   data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","content":[],"model":"claude-opus-4-8"}}
   
   event: content_block_start
   data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
   
   event: content_block_delta
   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
   
   event: content_block_stop
   data: {"type":"content_block_stop","index":0}
   
   event: message_delta
   data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}
   
   event: message_stop
   data: {"type":"message_stop"}

FIELD MAPPINGS:

1. Message ID:
   Chat: id → Messages: id (convert chatcmpl-* to msg_*)

2. Content:
   Chat: choices[0].message.content → Messages: content[0].text
   Chat: choices[0].message.tool_calls → Messages: content[n].tool_use

3. Tool calls:
   Chat: tool_calls[].id, function.name, function.arguments
   Messages: { type: 'tool_use', id, name, input }

4. Finish reason:
   Chat: 'stop' → Messages: 'end_turn'
   Chat: 'length' → Messages: 'max_tokens'
   Chat: 'tool_calls' → Messages: 'tool_use'
   Chat: 'content_filter' → Messages: 'stop_sequence' (approximation)

5. Usage:
   Chat: { prompt_tokens, completion_tokens, total_tokens }
   Messages: { input_tokens, output_tokens } (no total)

6. Model:
   Direct copy from request or response

STREAMING STATE MACHINE:

States:
- INITIAL → message_start
- CONTENT_STARTING → content_block_start
- CONTENT_STREAMING → content_block_delta (for each text chunk)
- CONTENT_ENDING → content_block_stop
- TOOL_CALL_COMPLETE → content_block_start/stop for tool_use
- MESSAGE_ENDING → message_delta + message_stop

Triggers:
- First chunk with role → message_start
- First content/tool_call → content_block_start
- Content delta → content_block_delta
- Finish reason appears → content_block_stop, message_delta, message_stop
*/

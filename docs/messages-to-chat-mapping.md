// Messages → Chat Completions conversion reference
// This documents the field mappings needed for Issue #4

/*
FIELD MAPPINGS:

1. Messages array:
   Anthropic Messages:
   {
     role: 'user' | 'assistant',
     content: string | [{ type: 'text', text: '...' }, { type: 'image', source: {...} }, { type: 'tool_use', id, name, input }]
   }
   
   OpenAI Chat:
   {
     role: 'user' | 'assistant' | 'system',
     content: string | [{ type: 'text', text: '...' }, { type: 'image_url', image_url: { url: '...' } }],
     tool_calls: [{ id, type: 'function', function: { name, arguments } }]
   }

2. System prompt:
   Anthropic: system: string | [{ type: 'text', text: '...' }]
   OpenAI: messages[0] = { role: 'system', content: '...' }

3. Tools:
   Anthropic: tools: [{ name, description, input_schema }]
   OpenAI: tools: [{ type: 'function', function: { name, description, parameters } }]

4. Tool choice:
   Anthropic: tool_choice: { type: 'auto' | 'any' | 'tool', name?: '...' }
   OpenAI: tool_choice: 'auto' | 'required' | { type: 'function', function: { name } }

5. Max tokens:
   Anthropic: max_tokens: number
   OpenAI: max_completion_tokens: number

6. Output format:
   Anthropic: output_config: { format: { type: 'json_schema', json_schema: {...} } }
   OpenAI: response_format: { type: 'json_schema', json_schema: {...} }

7. Temperature, top_p, stop: Direct mapping

8. Metadata:
   Anthropic: metadata: { user_id: '...' }
   OpenAI: user: '...'

FEATURES TO STRIP (when compatibility mode enabled):
- cache_control (all levels)
- thinking blocks
- Computer Use tools (computer_20241022, text_editor_20241022, bash_20241022)
*/

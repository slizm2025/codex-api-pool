# Adapter compatibility mode for Responses-only features

Codex may include Responses-only Features in every Responses request even when the user is only asking for ordinary text. Without a Native Responses Route, those capability declarations block otherwise usable Chat Completions or Anthropic Messages Upstreams.

The API Pool will support an opt-in Adapter Compatibility Mode. When a Responses request contains Responses-only Features and no Native Responses Route candidate is available, the pool may apply documented Compatibility Conversion, Compatibility Downgrade, and only then Compatibility Stripping before routing the request through a non-native adapter such as Chat Completions or Anthropic Messages.

Compatibility decisions must be explicit in diagnostics. The pool must report which tool types, input item types, content types, output formats, or fields were converted, downgraded, or removed in response headers, Recent Request Timeline entries, and Management Dashboard surfaces. It must not remove user content or mandatory tool intent when an official target field exists, and it must not run before checking for a Native Responses Route candidate.

Docs-backed mappings:

- OpenAI Chat Completions supports user content parts for `image_url`, `input_audio`, and `file`, `max_completion_tokens`, `response_format`, `web_search_options`, custom/function tools, `parallel_tool_calls`, `metadata`, `service_tier`, `prompt_cache_key`, `safety_identifier`, `verbosity`, `modalities`, `audio`, `prediction`, and `stream_options`.
- Anthropic Messages supports `image` blocks with `base64`, `url`, and file sources, `document` blocks for PDF/text/content sources, client tools with `input_schema`, server web search via `web_search_20260209`, tool search via `tool_search_tool_regex_20251119` or `tool_search_tool_bm25_20251119`, `tool_choice.disable_parallel_tool_use`, `output_config.format`, and `output_config.effort`.
- Responses `input_file` maps to Chat Completions `file` content parts only when the request has `file_id` or `file_data`/`filename`; it maps to Anthropic Messages `document` blocks when the request has PDF/text data or a URL document source. A Chat-targeted `input_file.file_url` has no documented equivalent and must be stripped with diagnostics in Adapter Compatibility Mode.
- When the main user content block is preserved but a target adapter cannot represent one of its known subfields, the subfield loss must be reported as a Compatibility Downgrade under `fields`, for example `input_image.detail` or `input_file.detail`.
- Responses `text.verbosity` maps to Chat Completions top-level `verbosity`. Anthropic Messages has no equivalent, so Adapter Compatibility Mode must strip it with diagnostics.
- Responses `previous_response_id`, `conversation`, `background`, `truncation`, `include`, `context_management`, `prompt`, `moderation`, and `max_tool_calls` are state, prompt-template, moderation, or tool-loop control fields with no direct Chat Completions or Anthropic Messages request equivalent.
- Responses `image_generation` is an image generation tool with no direct Chat Completions or Anthropic Messages tool equivalent.

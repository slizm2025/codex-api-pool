# Do not resume upstream streams after response starts

Once an Upstream has returned a successful response and the API Pool has begun forwarding the response stream, the pool will not attempt to resume the same generation on another Upstream if the stream breaks. Lossless stream resume would require request idempotency, context replay, and partial-output reconciliation, so the pool keeps Retry and Fallback on the pre-stream side of the Streaming Boundary and lets the current Codex turn fail or be retried by Codex.

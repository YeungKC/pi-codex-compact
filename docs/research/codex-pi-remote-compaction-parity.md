# Codex CLI and Pi Remote Compaction Parity

**Research date:** 2026-08-18
**Scope:** `Remote compaction`, `Model transition compaction`, `Automatic compaction boundary`, and `Fork request boundary`. Local text summarization and Codex token-budget fresh-context reset are out of scope.

## Primary sources

- OpenAI Codex, [`compact_remote_v2.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_remote_v2.rs)
- OpenAI Codex, [`compact_remote_v2_attempt.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_remote_v2_attempt.rs)
- OpenAI Codex, [`compact_remote_request.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_remote_request.rs)
- OpenAI Codex, [`compact_remote.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_remote.rs)
- OpenAI Codex, [`compact_model_fallback.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_model_fallback.rs)
- OpenAI Codex, [`responses_retry.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/responses_retry.rs)
- OpenAI Codex, [`protocol/src/error.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/error.rs)
- OpenAI Codex, [`tasks/compact.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tasks/compact.rs)
- Pi, [`compaction.md`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/compaction.md)
- Pi, [`extensions/types.ts`](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/extensions/types.ts)

## Codex CLI behavior to match

The current upstream snapshot (official `openai/codex` main, checked through 2026-08-17 UTC) routes built-in OpenAI/Azure Responses providers to V2 by default, Bedrock to V1, and arbitrary configured providers to `Unsupported`. Pi does not expose this provider capability metadata, so this extension's explicit V1/V2 configuration is a documented limitation rather than runtime probing.

1. **V2 request shape**
   - The V2 path sends the current prompt input, tools, base instructions, and one `compaction_trigger` item.
   - The response collector waits for `response.completed`, requires exactly one compaction output item, and ignores other output items.
   - The current source keeps a 64,000-token retained-message budget and caps retained `agent_message` items at 10,000 tokens.
   - Before the request, Codex rewrites old function-call output when the context window is exceeded.

2. **V2 retries and fallback**
   - The V2 stream retry budget is limited to two retries.
   - Retryable stream failures use the shared Responses retry policy and server-provided retry delays when present.
   - Model fallback is separate from stream retry. Current-model fallback is allowed for invalid request, unexpected status, context-window, usage-limit, server-overloaded, internal-server, and retry-limit categories. Cancellation, policy, quota, malformed, and unknown failures are not fallback candidates.

3. **V1 request shape**
   - The legacy remote path uses the compact conversation endpoint without the V2 `compaction_trigger` item.
   - The upstream V1 body carries model, input, instructions, tools, parallel tool calls, and available request controls. The extension reuses available non-input payload fields and keeps V1 behind explicit local configuration.
   - V1 is unary JSON. V2 is the streamed Responses path. They do not share the same terminal-event contract.

4. **Retry and transport**
   - Upstream V2 bounds stream retries at `min(provider.stream_max_retries, 2)` and can switch WebSocket to HTTPS after the transport retry budget. This extension uses the Pi-visible HTTPS fetch seam and cannot reproduce provider transport fallback without a provider transport API.
   - Upstream V1 uses the provider's unary request retry policy. This extension keeps a bounded common retry policy for both paths.

5. **History installation**
   - Codex filters the returned history to eligible user/developer/system messages and bounded agent messages, then installs the opaque compaction output as the native context checkpoint.
   - The checkpoint is installed before the next provider request and token usage is recomputed after installation.

## Pi boundary constraints

- `session_before_compact` can return a custom `CompactionResult` with `summary`, `firstKeptEntryId`, `tokensBefore`, `usage`, and extension `details`. It receives an `AbortSignal`.
- `before_provider_request` can replace the provider payload. Its `payload.input` is the authoritative request boundary for forked or transformed requests.
- Custom session entries do not participate in LLM context.
- Pi's built-in compaction uses a reserve-token threshold and a recent-message budget. It does not expose Codex's tokenizer, canonical BodyAfterPrefix baseline, provider capability metadata, or Codex's internal transport/session metadata.

## Current extension assessment

### Aligned

- V2 sends `compaction_trigger` and persists opaque `encrypted_content`.
- V2 retains recent eligible messages and uses the 64,000-token retained budget.
- Old function-call output is trimmed before remote compaction.
- Terminal SSE events stop the reader without waiting for EOF.
- Stream, HTTP, `response.failed`, and `response.incomplete` errors have explicit retry/fallback/fail-closed categories.
- Current-user preservation and checkpoint-only automatic-compaction suppression protect Pi's branch tail.

### Deliberate differences

- Provider capability metadata, Responses Lite, Codex request metadata/turn state, and WebSocket-to-HTTPS fallback are not exposed by the installed Pi 0.84.2 extension seams. The extension uses explicit V1/V2 configuration and HTTPS `fetch`.
- Upstream V2 preserves eligible media items outside the retained text-token budget. The extension mirrors that retention rule; its separate request and threshold estimates still use a best-effort image weight.
- Token counts use bounded JSON-size and image-weight approximations. They are not Codex's internal tokenizer.
- Pi stores a custom native checkpoint entry. It is not claimed to be identical to Codex's built-in `ContextCompactionItem` or Pi's built-in `CompactionEntry`.

### Adversarial findings fixed in this work

- Cross-model transitions now run only when both frozen `comp_hash` values exist and differ. Missing hashes skip only the transition check; rebound checkpoints remove a previous model's hash when the selected model has no comparable hash.
- Version-1 native checkpoints are recognized as legacy state and migrated by remote-compacting the full branch on the first request. A failed migration is retried on a later request.
- Model downshift compaction runs at the new model's automatic limit, independently of `comp_hash`.
- `bodyAfterPrefix` uses Total when Pi has no reliable prefix baseline.
- Compaction bodies preserve provider-supplied tools and tool-choice fields from the authoritative request payload instead of always rebuilding plain function tools.
- Authoritative instructions and provider-supplied tools/tool choice are reused from the request payload.

## Remaining non-parity areas

These are known constraints, not hidden guarantees:

- Exact Codex request metadata and transport selection are unavailable through the Pi extension seam.
- Exact tokenizer parity and mid-turn continuation are unavailable through Pi.
- Upstream Codex analytics and rollout trace metadata are not reproduced.

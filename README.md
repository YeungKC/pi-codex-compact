# pi-codex-compact

Pi extension implementing the observable Codex CLI remote compaction flow for `openai-codex` models.

## Codex CLI-compatible behavior

The extension follows Codex CLI's observable remote-compaction behavior where Pi exposes the required lifecycle hooks:

- Remote V2 is the default; legacy V1 is available through the explicit feature setting.
- Model-transition compaction is deferred until the first request after model selection.
- Opaque native checkpoints are persisted and replayed through Pi's session.
- Automatic compaction runs before the provider request instead of aborting a completed turn.

Pi does not expose every Codex CLI internal seam. Token accounting, provider capability metadata, mid-turn continuation, and fresh token-budget windows therefore use documented compatibility adaptations.

## Implementation details

- Sends the active Responses history followed by `{ "type": "compaction_trigger" }`.
- Uses the normal Codex Responses stream and requires exactly one `compaction` item with opaque `encrypted_content`.
- Persists the native checkpoint in Pi's session (a real compaction entry for Pi compaction and a custom entry for model transitions).
- Replays the checkpoint plus the active branch tail on later requests.
- Defers Codex-to-Codex model-transition compaction until the first request after selection, using the previous model and preserving that request's new input.
- Retains recent eligible message items, drops old tool/reasoning items, and caps retained agent messages at 10,000 tokens.
- Uses Codex V2's 64,000-token retained-message budget and trims old function-call output before remote requests.
- Runs automatic remote compaction in the awaited `before_provider_request` hook instead of aborting a completed turn.
- Uses the current request's non-input parameters for compaction and retries transition compaction with the current model if the previous model fails.
- Retries transient HTTP and stream failures.

For unsupported providers, Pi keeps ownership of local text summarization. For the explicit `tokenBudget` feature, the extension uses the closest available Pi compaction boundary; Pi extensions cannot create Codex's true fresh context window. The extension does not generate a local text summary and does not add a visible continuation message. Manual and overflow compactions use Pi's `session_before_compact` lifecycle hook; normal automatic compaction runs before the next provider request. If no limit is configured, the extension derives a 90% context-window limit, matching Codex's default. The built-in `openai-codex` provider is routed deterministically like Codex CLI: V2 by default, or V1 when the `remote_compaction_v2` feature is disabled.

To select the legacy V1 path explicitly:

```json
{
  "remoteCompactionV2": false,
  "tokenBudget": false,
  "autoCompactTokenLimit": 128000,
  "autoCompactScope": "total",
  "fallbackBufferTokens": 0
}
```

Save this as `~/.pi/agent/pi-codex-compact.json` or in a trusted project's `.pi/pi-codex-compact.json`. Runtime endpoint probing is not used.

## Install

From a local checkout:

```bash
pi install .
/reload
```

After publication:

```bash
pi install npm:pi-codex-compact
/reload
```

## Known boundary

Codex CLI owns exact provider capability metadata (`comp_hash`), token accounting, mid-turn continuation, and fresh token-budget context windows internally. Pi extensions do not expose those seams. This extension uses model metadata when Pi exposes a compaction hash, otherwise it conservatively compacts on a Codex model ID change; it estimates the pre-request history with the same 90% default, and uses Pi's closest token-budget boundary. These are explicit compatibility limits, not server probing or local-summary fallbacks.

Checkpoints are model-specific and are stored in the local Pi session JSONL.

# pi-codex-compact

Pi extension for Codex remote compaction on `openai-codex` models.

## Motivation

Long-lived coding sessions only work when compaction preserves the context that matters. Codex's model-native compaction is markedly better at this than replacing history with a local prose summary: it returns an opaque checkpoint that lets the model resume its own compressed state, including recent model-visible tool state.

In practice, this lets a single Codex session continue through repeated compactions without the gradual loss of continuity common with repeatedly summarized history. Results still depend on the selected model and Codex service; this is the intended benefit, not a fidelity guarantee.

## Install

Requires Node.js `>=22.19.0`, Pi `>=0.84.2`, and an `openai-codex` model.

```bash
pi install npm:@yeungkc/pi-codex-compact
/reload
```

For a local checkout:

```bash
pi install .
/reload
```

## Verify

Confirm that Pi registered the package:

```bash
pi list
```

Then, in an `openai-codex` session, run `/compact`. The checkpoint is stored in the local Pi session JSONL and is replayed on later requests.

## Configuration

No configuration is required. By default, the extension uses Codex remote-compaction V2 and automatically compacts retained history at 90% of the selected model's context window. The current user input is not included in this pre-request threshold check.

Optional configuration belongs in `~/.pi/agent/pi-codex-compact.json`. Missing or invalid fields leave the defaults in place:

```json
{
  "remoteCompactionV2": false,
  "autoCompactTokenLimit": 128000,
  "autoCompactScope": "total"
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `remoteCompactionV2` | `true` | Use Codex V2; set `false` only for the legacy V1 endpoint. |
| `autoCompactTokenLimit` | 90% of the model context window | Override the automatic-compaction threshold, capped at 90% of the model context window as in Codex. |
| `autoCompactScope` | `"total"` | Count estimated retained-history tokens; `"bodyAfterPrefix"` counts growth after the current compaction window's prefix. Until a prefix baseline exists, only the context-window hard cap triggers compaction. |

The extension does not probe endpoints at runtime.

## Behavior

Where Pi exposes the needed lifecycle hooks, this extension follows Codex CLI's observable remote-compaction flow:

- Sends active Responses history followed by `{ "type": "compaction_trigger" }`.
- Uses V2 by default and persists the returned opaque `encrypted_content` checkpoint.
- Replays the checkpoint with the active Pi branch tail on later requests.
- Defers model-transition compaction until the first request after model selection.
- Runs automatic compaction before a provider request, not after an aborted turn.
- Reuses Codex request settings for manual compaction and forwards the server's sticky turn state only within the active turn.
- Retains recent eligible user and agent messages, drops standalone developer/system and old tool/reasoning items, keeps an attached generated image-resize notice with its retained source, caps retained agent messages at 10,000 tokens, and applies Codex V2's 64,000-token retained-message budget.
- Retries transient HTTP and stream failures. For eligible model/request failures during a transition, it retries with the newly selected model.
- Automatically remote-compacts a newer history suffix for `context_length_exceeded`; if no complete suffix fits, the UI offers starting a new session or cancelling. Other blocked requests never retry unless the error is explicitly transient.

Unsupported providers keep Pi's normal local text summarization.

## Compatibility limits

Codex CLI internally owns exact `comp_hash` capability metadata, token accounting, mid-turn continuation, and provider retry settings. Pi does not expose those seams to extensions. Pi's WebSocket provider path also does not expose `response.metadata` turn-state events; use Pi's SSE transport when normal-response sticky routing must be observed by this extension. Remote compaction uses Codex's two-retry cap when Pi's provider retry setting is unavailable.

The extension therefore:

- uses the frozen Codex model hash snapshot; an absent hash skips only hash-transition compaction;
- replays a verifiable version-1 V2 checkpoint directly; otherwise migrates the full branch on the first request without replaying Pi's old prose compaction summary, and uses a bounded remote suffix recovery for `context_length_exceeded`;
- estimates history, the current compaction-window prefix, images, and tool output for automatic compaction;
- treats the actual pre-provider request as authoritative when a fork has changed Pi's inherited history.

These are deliberate compatibility adaptations, not server probing or local-summary fallbacks.

## Update and remove

```bash
pi update npm:@yeungkc/pi-codex-compact
pi uninstall npm:@yeungkc/pi-codex-compact
```

Removing the package does not delete existing Pi session JSONL files or their native checkpoints. Remove `~/.pi/agent/pi-codex-compact.json` separately if it is no longer wanted.

## Development

```bash
pnpm install --frozen-lockfile
pnpm test
```

## Troubleshooting and contributions

If this extension behaves unexpectedly in your Pi or Codex setup, fork this repository, install the fork locally with `pi install .`, and reproduce or diagnose the behavior in your own branch. Pull requests with a focused reproduction and tests are very welcome.

Do not include credentials or session JSONL content in an issue or pull request.

## License

[MIT](LICENSE)

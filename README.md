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

Then, in an `openai-codex` session, run `/compact`. A successful remote compaction displays `✓ OpenAI compaction complete`. The checkpoint is stored in the local Pi session JSONL and is replayed on later requests.

## Configuration

No configuration is required. By default, the extension uses Codex remote-compaction V2 and automatically compacts retained history at 90% of the selected model's context window. The current user input is not included in this pre-request threshold check.

Optional configuration belongs in `~/.pi/agent/pi-codex-compact.json`, or in a trusted project's `.pi/pi-codex-compact.json`. Pi loads the global file first; valid project settings override it. Missing or invalid fields leave the global or default value in place:

```json
{
  "remoteCompactionV2": false,
  "autoCompactTokenLimit": 128000,
  "autoCompactScope": "total",
  "debug": "errors"
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `remoteCompactionV2` | `true` | Use Codex V2; set `false` only for the legacy V1 endpoint. |
| `autoCompactTokenLimit` | 90% of the model context window | Override the automatic-compaction threshold. |
| `autoCompactScope` | `"total"` | Count estimated retained-history tokens; `"bodyAfterPrefix"` excludes a reliable prefix baseline when Pi exposes one. |
| `debug` | `"off"` | Persist sanitized compaction diagnostics: `"errors"` records retries/failures; `"verbose"` also records thresholds, requests, responses, and SSE event types. |

The extension does not probe endpoints at runtime. This repository includes `.pi/pi-codex-compact.json` with `"debug": "verbose"` for detailed local development diagnostics. Debug entries never include request input, authorization, tool payloads, or opaque checkpoint content.

## Behavior

Where Pi exposes the needed lifecycle hooks, this extension follows Codex CLI's observable remote-compaction flow:

- Sends active Responses history followed by `{ "type": "compaction_trigger" }`.
- Uses V2 by default and persists the returned opaque `encrypted_content` checkpoint.
- Replays the checkpoint with the active Pi branch tail on later requests.
- Defers model-transition compaction until the first request after model selection.
- Runs automatic compaction before a provider request, not after an aborted turn.
- Retains recent eligible messages, drops old tool/reasoning items, caps retained agent messages at 10,000 tokens, and applies Codex V2's 64,000-token retained-message budget.
- Retries transient HTTP and stream failures. For eligible model/request failures during a transition, it retries with the newly selected model.

Unsupported providers keep Pi's normal local text summarization.

## Compatibility limits

Codex CLI internally owns exact `comp_hash` capability metadata, token accounting, and mid-turn continuation. Pi does not expose those seams to extensions.

The extension therefore:

- uses the frozen Codex model hash snapshot; an absent hash skips only hash-transition compaction;
- migrates version-1 native checkpoints by remote-compacting the full branch on the first request;
- estimates history, stable system/tool prefix, images, and tool output for automatic compaction;
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

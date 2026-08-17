# Codex Compaction

Provides Pi integration for OpenAI Codex remote context checkpoints while preserving Pi's session and branch model.

The `remote-compaction` module owns V1/V2 protocol adapters and returns one native checkpoint shape. The `session-coordinator` module owns lifecycle state for deferred model transitions, pre-request automatic compaction, and failure gates; `index.ts` is the Pi lifecycle adapter.

## Language

**Native checkpoint**:
An opaque Codex `compaction` response item that carries resumable model state. It is not a human-readable summary.

**Replacement history**:
The bounded set of recent model-visible message items followed by one native checkpoint.

**Branch tail**:
Session entries created after the active native checkpoint and replayed together with that checkpoint.

**Model transition compaction**:
Compaction performed at the first request after a Codex model change, before that request is sent. Selecting a model alone does not compact. If both models expose compaction hashes and they match, the transition is skipped; if either hash is unavailable, the extension fails closed and does not guess a transition.

**Remote compaction**:
Codex server-side compaction requested through the Responses API with a `compaction_trigger` item.

**Compaction capability**:
The local Codex-compatible routing value `Unsupported`, `V1`, or `V2` that selects the compression implementation without probing the server.

**Remote-only scope**:
This extension targets Codex remote compaction paths; local text summarization and Codex token-budget fresh-context resets are intentionally delegated to Pi or Codex core and are not part of the parity target.

**Model-transition boundary**:
Pi exposes the selected and previous models, and its `before_provider_request` hook is awaited before the provider request. The extension records a pending Codex-to-Codex transition at selection time, then calls remote compaction with the previous model at the first request and persists a custom native checkpoint whose continuation model is the newly selected model. The current request's new input is appended after that checkpoint. The transition is fail-closed until the checkpoint is ready. The previous model is tried first; for eligible model/request failures, the current model is used as Codex's fallback, while authentication, policy, cancellation, malformed, and unknown protocol failures remain fail-closed. Pi's custom entry is not promised to be identical to a built-in CompactionEntry. The current request's non-input payload fields are reused for the checkpoint request.

**Fork request boundary**:
A fork may transform inherited Pi messages before the provider request, so its persisted branch need not reproduce the request prefix exactly. When a native checkpoint or pending transition requires compaction, the `before_provider_request` payload is authoritative: the extension compacts that exact input with the transition history model, persists a checkpoint for the selected model, and preserves the last user item if the replacement history omitted it. An ordinary mismatch without compaction state still passes through unchanged.

**Automatic compaction boundary**:
The awaited `before_provider_request` hook runs automatic remote compaction before the provider request. The extension estimates history plus a JSON-size approximation of the stable system/tool prefix, derives a 90% context-window limit when no explicit limit is configured, and applies best-effort image/tool weights. This avoids aborting a completed turn, but it is not Codex's internal tokenizer or mid-turn continuation seam.

**Body-after-prefix boundary**:
Pi does not expose Codex's canonical post-compaction prefix token baseline. The extension must not treat the first post-compaction aggregate usage as that baseline. When no reliable baseline exists, BodyAfterPrefix uses Total conservatively.

_Avoid_: local summary as an extension feature, text summary, server capability probing, subscription compaction

# Codex Compaction

This context defines the domain boundary for `pi-codex-compact`: keep Pi's remote Codex compaction behavior aligned with Codex `main@711a5f8b3a6e`. Local compaction paths are outside this context.

## Language

**Remote compaction**:
Codex server-side compaction of model-visible history into an opaque continuation state. This is the behavior the extension matches.

**Compaction trigger**:
A transient final request item that asks the remote Codex service to compact the supplied history. It is a request signal, not retained history.

**Turn state**:
A server response header used for sticky routing during one active Codex turn. The extension sends it on later requests and remote compaction in that turn, then clears it at turn boundaries. Pi exposes this header for HTTP responses and remote compaction; its WebSocket response metadata is not exposed to extensions.

**Request settings**:
The last Codex provider payload settings that Pi exposes. Manual compaction reuses its instructions, tools, reasoning, service tier, and text settings because Pi's compaction event does not carry the provider payload.

**Native compaction item**:
The opaque `compaction` item returned by remote compaction. It is model state for continuation, not a human-readable summary.

**Replacement history**:
The model-visible history installed after remote compaction: the native compaction item plus the history items Codex retains separately.

**Compaction window**:
The active period that starts when replacement history becomes live and ends at the next remote compaction. Body-after-prefix usage counts growth within this window.

**Auto-compaction scope**:
`Total` counts active context. `BodyAfterPrefix` counts context growth after the current window's prefix; when no prefix baseline exists, its scoped usage is zero while the full context-window limit still applies.

**Retained item**:
An original history item that remains separately visible in replacement history after remote compaction. V2 applies Codex's item filters and retained-message budget; this excludes standalone developer/system items and keeps only eligible user and agent messages, plus an immediately attached generated image-resize notice.

**Compaction compatibility**:
Whether a model or configuration can continue from an existing native compaction item. Codex represents this with optional `comp_hash`; an absent hash is not evidence of incompatibility.

**Context overflow recovery**:
A lossy remote-only continuation for `context_length_exceeded`: the newest complete history suffix is remote-compacted, the current request is kept, and older history remains in the event log but is no longer model-visible. The bounded recovery runs automatically once because reducing the visible history is the only same-model continuation. If it fails, the extension emits a safe Failure notice and cancels only the current operation; the session remains usable for a later manual retry. It never bypasses authentication, policy, malformed-checkpoint, or protocol protection.

**Model-transition compaction**:
Remote compaction performed before a request when two known Codex `comp_hash` values differ. Missing hash values skip this transition check.

**Unsupported checkpoint**:
A native compaction entry from an older protocol or extension version. The extension ignores it and replays Pi's normal branch. A later V2 compaction can write a current replacement; it never calls a legacy endpoint or blocks the session permanently.

**Malformed checkpoint**:
A native compaction entry that fails the current V2 schema. It is ignored and the full branch is replayed; a later remote compaction can write a valid replacement instead of permanently blocking the session.

**Failed request marker**:
A non-model-visible session entry that identifies a user input blocked before provider execution. The next request excludes that stale entry from history while keeping a retry as the current input. New markers persist only the referenced entry ID and safe diagnostic metadata (`phase`, canonical machine `code`, and `recoveryAttempted`); they contain neither raw request input nor raw error text. Older markers may contain legacy content, which is ignored when the referenced branch entry is available.

**Remote-only scope**:
The parity target covers Codex remote compaction, including manual, pre-turn, mid-turn, and model-transition request boundaries. Pi local text summaries and Codex local or fresh-context reset paths are outside this context. Configured auto-compaction limits are capped at Codex's 90% context-window limit.

_Avoid_: local summary, prose checkpoint, trigger as history, permanent fail-closed session

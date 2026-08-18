# Codex Compaction

This context defines the domain boundary for `pi-codex-compact`: keep Pi's remote Codex compaction behavior aligned with Codex `main@711a5f8b3a6e`. Local compaction paths are outside this context.

## Language

**Remote compaction**:
Codex server-side compaction of model-visible history into an opaque continuation state. This is the behavior the extension matches.

**Compaction trigger**:
A transient final request item that asks the remote Codex service to compact the supplied history. It is a request signal, not retained history.

**Native compaction item**:
The opaque `compaction` item returned by remote compaction. It is model state for continuation, not a human-readable summary.

**Replacement history**:
The model-visible history installed after remote compaction: the native compaction item plus the history items Codex retains separately.

**Compaction window**:
The active period that starts when replacement history becomes live and ends at the next remote compaction. Body-after-prefix usage counts growth within this window.

**Auto-compaction scope**:
`Total` counts active context. `BodyAfterPrefix` counts context growth after the current window's prefix; when no prefix baseline exists, its scoped usage is zero while the full context-window limit still applies.

**Retained item**:
An original history item that remains separately visible in replacement history after remote compaction. V2 applies Codex's item filters and retained-message budget; by default this excludes developer/system items and keeps only eligible user and agent messages.

**Compaction compatibility**:
Whether a model or configuration can continue from an existing native compaction item. Codex represents this with optional `comp_hash`; an absent hash is not evidence of incompatibility.

**Model-transition compaction**:
Remote compaction performed before a request when two known Codex `comp_hash` values differ. Missing hash values skip this transition check.

**Legacy checkpoint**:
A version-1 native compaction entry written by an earlier extension version. The first request migrates it by remote-compacting the full branch instead of replaying its stored replacement history.

**Malformed checkpoint**:
A native compaction entry that fails the current schema. It is ignored and the full branch is replayed; a later remote compaction can write a valid replacement instead of permanently blocking the session.

**Failed request marker**:
A non-model-visible session entry that identifies a user input blocked before provider execution. The next request excludes that stale entry from history while keeping a retry as the current input.

**Remote-only scope**:
The parity target covers Codex remote compaction, including manual, pre-turn, mid-turn, and model-transition request boundaries. Pi local text summaries and Codex local or fresh-context reset paths are outside this context. Configured auto-compaction limits are capped at Codex's 90% context-window limit.

_Avoid_: local summary, prose checkpoint, trigger as history, permanent fail-closed session

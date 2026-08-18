import type { Model } from "@earendil-works/pi-ai";
import type { CodexCompactionConfig } from "./config.ts";

export type CodexCompactionCapability = "v2" | "v1" | "local";

// Snapshot from codex-rs/models-manager/models.json at the frozen Codex baseline.
// An absent entry means that Codex has no comparable comp_hash metadata.
const CODEX_COMPACTION_HASHES: Record<string, string> = {
	"gpt-5.6-sol": "3000",
	"gpt-5.6-terra": "3000",
	"gpt-5.6-luna": "3000",
	"gpt-5.5": "2911",
	"gpt-5.4": "2911",
	"gpt-5.4-mini": "2911",
};

export function compactionHash(model: Model<any>): string | undefined {
	if (model.provider !== "openai-codex" || model.api !== "openai-codex-responses") return undefined;
	return CODEX_COMPACTION_HASHES[model.id];
}

/** Mirrors Codex's local provider routing: OpenAI supports remote compaction; other providers do not. */
export function compactionCapability(
	model: Model<any>,
	config: CodexCompactionConfig,
): CodexCompactionCapability {
	if (model.provider !== "openai-codex" || model.api !== "openai-codex-responses") return "local";
	return config.remoteCompactionV2 ? "v2" : "v1";
}

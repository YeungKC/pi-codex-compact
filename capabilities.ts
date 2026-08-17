import type { Model } from "@earendil-works/pi-ai";
import type { CodexCompactionConfig } from "./config.ts";

export type CodexCompactionCapability = "v2" | "v1" | "local";

const CODEX_COMPACTION_HASHES: Record<string, string> = {
	"gpt-5.6-sol": "3000",
	"gpt-5.6-terra": "3000",
	"gpt-5.6-luna": "3000",
	"gpt-5.5": "2911",
	"gpt-5.4": "2911",
	"gpt-5.4-mini": "2911",
};

export function compactionHash(model: Model<any>): string | undefined {
	const value = model as Model<any> & { compHash?: unknown; comp_hash?: unknown };
	if (typeof value.compHash === "string") return value.compHash;
	if (typeof value.comp_hash === "string") return value.comp_hash;
	return CODEX_COMPACTION_HASHES[model.id];
}

/** Mirrors Codex's local provider routing: OpenAI supports remote compaction; other providers do not. */
export function compactionCapability(
	model: Model<any>,
	config: CodexCompactionConfig,
): CodexCompactionCapability {
	if (model.provider !== "openai-codex") return "local";
	return config.remoteCompactionV2 ? "v2" : "v1";
}

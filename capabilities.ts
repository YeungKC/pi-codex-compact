import type { Model } from "@earendil-works/pi-ai";
import type { CodexCompactionConfig } from "./config.ts";

export type CodexCompactionCapability = "v2" | "v1" | "local" | "token-budget";

const CODEX_COMPACTION_HASHES: Record<string, string> = {
	"gpt-5.6-sol": "3000",
	"gpt-5.6-terra": "3000",
	"gpt-5.6-luna": "3000",
	"gpt-5.5": "2911",
	"gpt-5.4": "2911",
	"gpt-5.4-mini": "2911",
};

export function compactionHash(model: Model<any>): string | undefined {
	const known = CODEX_COMPACTION_HASHES[model.id];
	if (known) return known;
	const value = model as Model<any> & { compHash?: unknown; comp_hash?: unknown };
	return typeof value.compHash === "string" ? value.compHash : typeof value.comp_hash === "string" ? value.comp_hash : undefined;
}

/** Mirrors Codex's local provider routing: OpenAI supports remote compaction; other providers do not. */
export function compactionCapability(
	model: Model<any>,
	config: CodexCompactionConfig,
): CodexCompactionCapability {
	if (config.tokenBudget) return "token-budget";
	if (model.provider !== "openai-codex") return "local";
	return config.remoteCompactionV2 ? "v2" : "v1";
}

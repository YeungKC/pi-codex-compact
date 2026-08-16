import type { Model } from "@earendil-works/pi-ai";
import type { CodexCompactionConfig } from "./config.ts";

export type CodexCompactionCapability = "v2" | "v1" | "local" | "token-budget";

/** Mirrors Codex's local provider routing: OpenAI supports remote compaction; other providers do not. */
export function compactionCapability(
	model: Model<any>,
	config: CodexCompactionConfig,
): CodexCompactionCapability {
	if (config.tokenBudget) return "token-budget";
	if (model.provider !== "openai-codex") return "local";
	return config.remoteCompactionV2 ? "v2" : "v1";
}

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export type CodexCompactionConfig = {
	/** Mirrors Codex's remote_compaction_v2 feature gate. */
	remoteCompactionV2: boolean;
	/** Mirrors Codex's token_budget feature gate. */
	tokenBudget: boolean;
	/** Optional Codex-style auto-compaction limit. */
	autoCompactTokenLimit?: number;
	autoCompactScope: "total" | "bodyAfterPrefix";
	fallbackBufferTokens: number;
};

const DEFAULT_CONFIG: CodexCompactionConfig = {
	remoteCompactionV2: true,
	tokenBudget: false,
	autoCompactScope: "total",
	fallbackBufferTokens: 0,
};

function readConfig(path: string): Partial<CodexCompactionConfig> {
	if (!existsSync(path)) return {};
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return {
			...(typeof value.remoteCompactionV2 === "boolean" ? { remoteCompactionV2: value.remoteCompactionV2 } : {}),
			...(typeof value.tokenBudget === "boolean" ? { tokenBudget: value.tokenBudget } : {}),
			...(typeof value.autoCompactTokenLimit === "number" && value.autoCompactTokenLimit > 0
				? { autoCompactTokenLimit: value.autoCompactTokenLimit }
				: {}),
			...(value.autoCompactScope === "total" || value.autoCompactScope === "bodyAfterPrefix"
				? { autoCompactScope: value.autoCompactScope }
				: {}),
			...(typeof value.fallbackBufferTokens === "number" && value.fallbackBufferTokens >= 0
				? { fallbackBufferTokens: value.fallbackBufferTokens }
				: {}),
		};
	} catch {
		return {};
	}
}

export function loadConfig(cwd: string, trusted: boolean): CodexCompactionConfig {
	const global = readConfig(join(homedir(), CONFIG_DIR_NAME, "agent", "pi-codex-compact.json"));
	const project = trusted ? readConfig(join(cwd, CONFIG_DIR_NAME, "pi-codex-compact.json")) : {};
	return { ...DEFAULT_CONFIG, ...global, ...project };
}

/** Codex derives an omitted auto limit from the model context window. */
export function autoCompactTokenLimit(config: CodexCompactionConfig, contextWindow: number): number {
	return config.autoCompactTokenLimit ?? Math.floor(contextWindow * 0.9);
}

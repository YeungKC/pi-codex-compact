import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export type CompactionDebugLevel = "off" | "errors" | "verbose";

export type CodexCompactionConfig = {
	/** Mirrors the remote_compaction_v2 feature gate. */
	remoteCompactionV2: boolean;
	/** Optional Codex-style auto-compaction limit. */
	autoCompactTokenLimit?: number;
	autoCompactScope: "total" | "bodyAfterPrefix";
	/** Persist sanitized compaction diagnostics in custom session entries. */
	debug?: CompactionDebugLevel;
};

const DEFAULT_CONFIG: CodexCompactionConfig = {
	remoteCompactionV2: true,
	autoCompactScope: "total",
	debug: "off",
};

export function parseConfig(input: unknown): Partial<CodexCompactionConfig> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
	const value = input as Record<string, unknown>;
	return {
		...(typeof value.remoteCompactionV2 === "boolean" ? { remoteCompactionV2: value.remoteCompactionV2 } : {}),
		...(typeof value.autoCompactTokenLimit === "number" && value.autoCompactTokenLimit > 0
			? { autoCompactTokenLimit: value.autoCompactTokenLimit }
			: {}),
		...(value.autoCompactScope === "total" || value.autoCompactScope === "bodyAfterPrefix"
			? { autoCompactScope: value.autoCompactScope }
			: {}),
		...(value.debug === "off" || value.debug === "errors" || value.debug === "verbose"
			? { debug: value.debug }
			: {}),
	};
}

function readConfig(path: string): Partial<CodexCompactionConfig> {
	if (!existsSync(path)) return {};
	try {
		return parseConfig(JSON.parse(readFileSync(path, "utf8")));
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

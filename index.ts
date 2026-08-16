import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { compactionCapability } from "./capabilities.ts";
import { shouldAutoCompact } from "./scheduler.ts";
import { autoCompactTokenLimit, loadConfig } from "./config.ts";
import { Text } from "@earendil-works/pi-tui";
import { createNativeCheckpoint } from "./remote-compaction.ts";
import { createSessionCoordinator } from "./session-coordinator.ts";
import {
	effectiveInputForBranch,
	findNativeCheckpoint,
	isJsonObject,
	isOpenAICodexModel,
	mergeFeatureHeader,
	modelKey,
	approximateResponseItemTokens,
	stripInputFromPayload,
	NATIVE_COMPACTION_KIND,
	NATIVE_COMPACTION_VERSION,
	type JsonObject,
} from "./native-compaction.ts";

type CompactionStatus = {
	state: "running" | "complete" | "failed";
	error?: string;
};

const COMPACTION_STATUS_KIND = "openai-codex-compaction-status";
const LOCAL_MARKER = "OpenAI Codex native compaction checkpoint.";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function setFeatureHeader(headers: Record<string, string | null>): void {
	const existing = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-codex-beta-features");
	if (existing) {
		headers[existing[0]] = mergeFeatureHeader(existing[1]);
	} else {
		headers["x-codex-beta-features"] = mergeFeatureHeader(undefined);
	}
}

export default function codexCompactionExtension(pi: ExtensionAPI): void {

	pi.registerEntryRenderer<CompactionStatus>(COMPACTION_STATUS_KIND, (entry, _options, theme) => {
		const data = entry.data;
		if (data?.state === "running") {
			return new Text(theme.fg("accent", "◐ OpenAI compaction running…"), 0, 0);
		}
		if (data?.state === "complete") {
			return new Text(theme.fg("success", "✓ OpenAI compaction complete"), 0, 0);
		}
		const suffix = data?.error ? `: ${data.error}` : "";
		return new Text(theme.fg("error", `✗ OpenAI compaction failed${suffix}`), 0, 0);
	});

	const appendCompactionStatus = (ctx: ExtensionContext, status: CompactionStatus): void => {
		if (ctx.mode === "tui") pi.appendEntry(COMPACTION_STATUS_KIND, status);
	};

	const withCompactionStatus = async <T>(
		ctx: ExtensionContext,
		operation: () => Promise<T>,
	): Promise<T> => {
		appendCompactionStatus(ctx, { state: "running" });
		try {
			const result = await operation();
			appendCompactionStatus(ctx, { state: "complete" });
			return result;
		} catch (error) {
			appendCompactionStatus(ctx, { state: "failed", error: errorMessage(error) });
			throw error;
		}
	};

	const coordinator = createSessionCoordinator({
		getBranch: (ctx) => ctx.sessionManager.getBranch() as SessionEntry[],
		getAllTools: () => pi.getAllTools(),
		createCheckpoint: ({ ctx, model, input, basePayload }) => createNativeCheckpoint({
			ctx,
			model,
			input,
			basePayload,
			config: loadConfig(ctx.cwd, ctx.isProjectTrusted()),
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
		}),
		withStatus: withCompactionStatus,
		appendCheckpoint: (details) => pi.appendEntry(NATIVE_COMPACTION_KIND, details),
		shouldAutoCompact: ({ ctx, model, input }) => {
			const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			if (config.tokenBudget) return false;
			return shouldAutoCompact({
				status: {
					activeContextTokens: approximateResponseItemTokens(input),
					contextWindow: model.contextWindow,
				},
				limit: autoCompactTokenLimit(config, model.contextWindow),
				scope: config.autoCompactScope,
				fallbackBufferTokens: config.fallbackBufferTokens,
			});
		},
	});

	pi.on("session_start", () => {
		coordinator.clear();
	});
	pi.on("session_shutdown", () => {
		coordinator.clear();
	});
	pi.on("model_select", (event, ctx) => {
		if (loadConfig(ctx.cwd, ctx.isProjectTrusted()).tokenBudget) coordinator.clear();
		else return coordinator.selectModel(event, ctx);
	});


	pi.on("context", (event, ctx) => {
		const checkpoint = findNativeCheckpoint(ctx.sessionManager.getBranch() as SessionEntry[]);
		if (checkpoint.status === "none") return undefined;
		return {
			messages: event.messages.filter((message) => message.role !== "compactionSummary"),
		};
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (!isOpenAICodexModel(ctx.model)) return;
		if (loadConfig(ctx.cwd, ctx.isProjectTrusted()).remoteCompactionV2) {
			setFeatureHeader(event.headers);
		}
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const model = ctx.model;
		if (!isOpenAICodexModel(model) || !isJsonObject(event.payload)) return undefined;
		if (loadConfig(ctx.cwd, ctx.isProjectTrusted()).tokenBudget) return undefined;
		try {
			const transitionFailure = coordinator.transitionFailure(sessionId, model);
			if (transitionFailure) throw new Error(transitionFailure);
			const requestInput = Array.isArray(event.payload.input) ? event.payload.input : undefined;
			const input = await coordinator.prepareRequest(
				model,
				ctx,
				requestInput,
				stripInputFromPayload(event.payload),
			);
			if (!input) return undefined;
			const payload: JsonObject = { ...event.payload, input };
			delete payload.messages;
			delete payload.previous_response_id;
			return payload;
		} catch (error) {
			ctx.abort();
			if (ctx.hasUI) {
				ctx.ui.notify(`OpenAI Codex request blocked: ${errorMessage(error)}`, "error");
			}
			const payload: JsonObject = { ...event.payload, input: null };
			delete payload.messages;
			delete payload.previous_response_id;
			return payload;
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!model) return undefined;
		const capability = compactionCapability(model, loadConfig(ctx.cwd, ctx.isProjectTrusted()));
		if (capability === "local") return undefined;
		if (capability === "token-budget") {
			const lastEntryId = (event.branchEntries as SessionEntry[]).at(-1)?.id;
			return {
				compaction: {
					summary: LOCAL_MARKER,
					firstKeptEntryId: event.willRetry
						? event.preparation.firstKeptEntryId
						: (lastEntryId ?? event.preparation.firstKeptEntryId),
					tokensBefore: event.preparation.tokensBefore,
					details: {
						kind: NATIVE_COMPACTION_KIND,
						version: NATIVE_COMPACTION_VERSION,
						strategy: "token-budget",
						modelKey: modelKey(model),
						replacementHistory: [],
					},
				},
			};
		}
		if (!isOpenAICodexModel(model)) return undefined;

		try {
			const branch = event.branchEntries as SessionEntry[];
			const input = effectiveInputForBranch({
				branch,
				model,
				tools: pi.getAllTools(),
				excludeLastAssistantError: event.reason === "overflow" && event.willRetry,
				allowCheckpointModelMismatch: true,
			});
			const native = await withCompactionStatus(ctx, () => createNativeCheckpoint({
				ctx,
				model,
				input,
				signal: event.signal,
				config: loadConfig(ctx.cwd, ctx.isProjectTrusted()),
				allTools: pi.getAllTools(),
				activeToolNames: pi.getActiveTools(),
			}));

			return {
				compaction: {
					summary: LOCAL_MARKER,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: native.usage,
					details: native.details,
				},
			};
		} catch (error) {
			if (!event.signal.aborted && ctx.hasUI) {
				ctx.ui.notify(`OpenAI Codex native compaction failed: ${errorMessage(error)}`, "error");
			}
			return { cancel: true };
		}
	});

}

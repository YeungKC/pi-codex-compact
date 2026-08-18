import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { compactionCapability, compactionHash } from "./capabilities.ts";
import { shouldAutoCompact } from "./scheduler.ts";
import { autoCompactTokenLimit, loadConfig, type CompactionDebugLevel } from "./config.ts";
import { Text } from "@earendil-works/pi-tui";
import { createNativeCheckpoint } from "./remote-compaction.ts";
import { createSessionCoordinator } from "./session-coordinator.ts";
import {
	effectiveInputForBranch,
	findNativeCheckpoint,
	isJsonObject,
	isOpenAICodexModel,
	mergeFeatureHeader,
	removeFeatureHeader,
	approximateResponseItemTokens,
	approximateTokenCount,
	buildToolPayload,
	compactionErrorSummary,
	stripInputFromPayload,
	modelKey,
	NATIVE_COMPACTION_KIND,
	type JsonObject,
	type NativeCompactionDebugEvent,
	type NativeCompactionDebugSink,
} from "./native-compaction.ts";

type CompactionStatus = {
	state: "running" | "complete" | "failed";
	error?: string;
};

const COMPACTION_STATUS_KIND = "openai-codex-compaction-status";
const COMPACTION_DEBUG_KIND = "openai-codex-compaction-debug";
const LOCAL_MARKER = "OpenAI Codex native compaction checkpoint.";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function debugText(event: NativeCompactionDebugEvent): string {
	const parts = [`◌ Codex compaction ${event.phase}`];
	if (event.strategy) parts.push(event.strategy);
	if (event.model) parts.push(event.model);
	if (event.previousModel) parts.push(`previous=${event.previousModel}`);
	if (event.previousHashAvailable !== undefined) parts.push(`previousHash=${event.previousHashAvailable}`);
	if (event.currentHashAvailable !== undefined) parts.push(`currentHash=${event.currentHashAvailable}`);
	if (event.attempt !== undefined) parts.push(`attempt=${event.attempt}/${event.maxAttempts ?? "?"}`);
	if (event.status !== undefined) parts.push(`status=${event.status}`);
	if (event.eventType) parts.push(`event=${event.eventType}`);
	if (event.delayMs !== undefined) parts.push(`delay=${event.delayMs}ms`);
	if (event.estimatedInputTokens !== undefined) parts.push(`input≈${event.estimatedInputTokens}`);
	if (event.reservedTokens !== undefined) parts.push(`reserved≈${event.reservedTokens}`);
	if (event.toolCount !== undefined) parts.push(`tools=${event.toolCount}`);
	if (event.toolTypes?.length) parts.push(`toolTypes=${event.toolTypes.join(",")}`);
	if (event.activeContextTokens !== undefined) parts.push(`active≈${event.activeContextTokens}`);
	if (event.limit !== undefined) parts.push(`limit=${event.limit}`);
	if (event.scope) parts.push(`scope=${event.scope}`);
	if (event.baselineSource) parts.push(`baseline=${event.baselineSource}`);
	if (event.decision !== undefined) parts.push(`auto=${event.decision}`);
	if (event.error) parts.push(event.error);
	return parts.join(" ");
}

function setFeatureHeader(headers: Record<string, string | null>, includeRemoteCompactionV2: boolean): void {
	const existing = Object.entries(headers).find(([name]) => name.toLowerCase() === "x-codex-beta-features");
	const features = includeRemoteCompactionV2
		? mergeFeatureHeader(existing?.[1])
		: removeFeatureHeader(existing?.[1]);
	if (features) {
		headers[existing?.[0] ?? "x-codex-beta-features"] = features;
	} else if (existing) {
		delete headers[existing[0]];
	}
}

export default function codexCompactionExtension(pi: ExtensionAPI): void {

	pi.registerEntryRenderer<NativeCompactionDebugEvent>(COMPACTION_DEBUG_KIND, (entry, _options, theme) => {
		return new Text(theme.fg("accent", debugText(entry.data)), 0, 0);
	});

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

	const debugSink = (_ctx: ExtensionContext, level: CompactionDebugLevel | undefined): NativeCompactionDebugSink | undefined => {
		if (!level || level === "off") return undefined;
		return (event) => {
			if (level === "errors" && event.phase !== "failed" && event.phase !== "retry") return;
			pi.appendEntry(COMPACTION_DEBUG_KIND, event);
		};
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
			appendCompactionStatus(ctx, { state: "failed", error: compactionErrorSummary(error) });
			throw error;
		}
	};

	const coordinator = createSessionCoordinator({
		getBranch: (ctx) => ctx.sessionManager.getBranch() as SessionEntry[],
		getAllTools: () => pi.getAllTools(),
		createCheckpoint: ({ ctx, model, input, basePayload, signal }) => {
			const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			return createNativeCheckpoint({
				ctx,
				model,
				input,
				basePayload,
				signal,
				config,
				allTools: pi.getAllTools(),
				activeToolNames: pi.getActiveTools(),
				debug: debugSink(ctx, config.debug),
			});
		},
		withStatus: withCompactionStatus,
		appendCheckpoint: (details) => pi.appendEntry(NATIVE_COMPACTION_KIND, details),
		shouldAutoCompact: ({ ctx, model, input }) => {
			const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			// Pi does not expose Codex's exact usage/prefill split; count the stable prefix approximately.
			const estimatedPrefillTokens = approximateTokenCount({
				instructions: ctx.getSystemPrompt(),
				tools: buildToolPayload(pi.getAllTools(), pi.getActiveTools()),
			});
			const activeContextTokens = approximateResponseItemTokens(input) + estimatedPrefillTokens;
			const limit = autoCompactTokenLimit(config, model.contextWindow);
			const decision = shouldAutoCompact({
				status: { activeContextTokens, contextWindow: model.contextWindow },
				limit,
				scope: config.autoCompactScope,
			});
			debugSink(ctx, config.debug)?.({
				phase: "threshold",
				model: modelKey(model),
				activeContextTokens,
				prefillTokens: estimatedPrefillTokens,
				limit,
				scope: config.autoCompactScope,
				baselineSource: "unavailable",
				decision,
			});
			return decision;
		},
	});

	pi.on("session_start", () => {
		coordinator.clear();
	});
	pi.on("session_shutdown", () => {
		coordinator.clear();
	});
	pi.on("model_select", async (event, ctx) => {
		await coordinator.selectModel(event, ctx);
		const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		debugSink(ctx, config.debug)?.({
			phase: "transition",
			model: modelKey(event.model),
			previousModel: event.previousModel ? modelKey(event.previousModel) : undefined,
			previousHashAvailable: event.previousModel ? compactionHash(event.previousModel) !== undefined : undefined,
			currentHashAvailable: compactionHash(event.model) !== undefined,
		});
	});

	pi.on("context", (event, ctx) => {
		if (!isOpenAICodexModel(ctx.model)) return undefined;
		const checkpoint = findNativeCheckpoint(ctx.sessionManager.getBranch() as SessionEntry[]);
		if (checkpoint.status !== "valid") return undefined;
		return {
			messages: event.messages.filter((message) => message.role !== "compactionSummary"),
		};
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (!isOpenAICodexModel(ctx.model)) return;
		setFeatureHeader(event.headers, loadConfig(ctx.cwd, ctx.isProjectTrusted()).remoteCompactionV2);
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const model = ctx.model;
		if (!isOpenAICodexModel(model) || !isJsonObject(event.payload)) return undefined;
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
		const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		const capability = compactionCapability(model, config);
		if (capability === "local") return undefined;
		if (!isOpenAICodexModel(model)) return undefined;

		try {
			const branch = event.branchEntries as SessionEntry[];
			const input = effectiveInputForBranch({
				branch,
				model,
				tools: pi.getAllTools(),
				excludeLastAssistantError: event.reason === "overflow" && event.willRetry,
			});
			const native = await withCompactionStatus(ctx, () => createNativeCheckpoint({
				ctx,
				model,
				input,
				signal: event.signal,
				config,
				allTools: pi.getAllTools(),
				activeToolNames: pi.getActiveTools(),
				debug: debugSink(ctx, config.debug),
			}));
			const requestUser = input.findLast((item) => item.role === "user");
			const knownUsers = [
				...native.details.replacementHistory,
				...(native.details.preservedInput ?? []),
			];
			const details = requestUser && !knownUsers.some((item) =>
				item.role === "user" && JSON.stringify(item.content) === JSON.stringify(requestUser.content)
			)
				? { ...native.details, preservedInput: [...(native.details.preservedInput ?? []), structuredClone(requestUser)] }
				: native.details;

			return {
				compaction: {
					summary: LOCAL_MARKER,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					usage: native.usage,
					details,
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

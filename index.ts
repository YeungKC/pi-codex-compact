import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { shouldAutoCompact } from "./scheduler.ts";
import { autoCompactTokenLimit, loadConfig } from "./config.ts";
import { createNativeCheckpoint } from "./remote-compaction.ts";
import { createSessionCoordinator } from "./session-coordinator.ts";
import {
	estimateCompactionWindowPrefillTokens,
	findNativeCheckpoint,
	fullInputForBranch,
	isJsonObject,
	isOpenAICodexModel,
	mergeFeatureHeader,
	removeFeatureHeader,
	approximateResponseItemTokens,
	approximateTokenCount,
	buildToolPayload,
	stripInputFromPayload,
	NATIVE_COMPACTION_KIND,
	type JsonObject,
} from "./native-compaction.ts";

const LOCAL_MARKER = "OpenAI Codex native compaction checkpoint.";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
			});
		},
		appendCheckpoint: (details) => pi.appendEntry(NATIVE_COMPACTION_KIND, details),
		shouldAutoCompact: ({ ctx, model, input }) => {
			const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			// Pi exposes assistant usage but not Codex's window counters; estimate the stable prefix.
			const estimatedStablePrefixTokens = approximateTokenCount({
				instructions: ctx.getSystemPrompt(),
				tools: buildToolPayload(pi.getAllTools(), pi.getActiveTools()),
			});
			const activeContextTokens = approximateResponseItemTokens(input) + estimatedStablePrefixTokens;
			const prefillTokens = config.autoCompactScope === "bodyAfterPrefix"
				? estimateCompactionWindowPrefillTokens({
						branch: ctx.sessionManager.getBranch() as SessionEntry[],
						stablePrefixTokens: estimatedStablePrefixTokens,
					})
				: undefined;
			const limit = autoCompactTokenLimit(config, model.contextWindow);
			return shouldAutoCompact({
				status: {
					activeContextTokens,
					contextWindow: model.contextWindow,
					...(prefillTokens !== undefined ? { prefillTokens } : {}),
				},
				limit,
				scope: config.autoCompactScope,
			});
		},
	});

	pi.on("session_start", coordinator.clear);
	pi.on("session_shutdown", coordinator.clear);
	pi.on("model_select", async (event, ctx) => {
		await coordinator.selectModel(event, ctx);
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
		const model = ctx.model;
		if (!isOpenAICodexModel(model) || !isJsonObject(event.payload)) return undefined;
		try {
			const requestInput = Array.isArray(event.payload.input) ? event.payload.input : undefined;
			const input = await coordinator.prepareRequest(
				model,
				ctx,
				requestInput,
				stripInputFromPayload(event.payload),
			);
			if (!input) return undefined;
			const payload = stripInputFromPayload(event.payload);
			payload.input = input;
			return payload;
		} catch (error) {
			ctx.abort();
			closeOpenAICodexWebSocketSessions(ctx.sessionManager.getSessionId());
			if (ctx.hasUI) {
				ctx.ui.notify(`OpenAI Codex request blocked: ${errorMessage(error)}`, "error");
			}
			// The abort signal stops Pi's provider call. A synthetic `input: null`
			// would create a second protocol error.
			return undefined;
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!model || !isOpenAICodexModel(model)) return undefined;
		const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());

		try {
			const branch = event.branchEntries as SessionEntry[];
			const requestInput = fullInputForBranch({
				branch,
				model,
				tools: pi.getAllTools(),
			});
			const input = await coordinator.prepareCompaction(
				model,
				ctx,
				requestInput,
				undefined,
				event.reason === "overflow" && event.willRetry,
				event.signal,
			);
			const native = await createNativeCheckpoint({
				ctx,
				model,
				input,
				signal: event.signal,
				config,
				allTools: pi.getAllTools(),
				activeToolNames: pi.getActiveTools(),
			});
			if (event.signal.aborted) return { cancel: true };
			const requestUser = requestInput.findLast((item) => item.role === "user");
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

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { shouldAutoCompact } from "./scheduler.ts";
import { autoCompactTokenLimit, loadConfig } from "./config.ts";
import { createNativeCheckpoint } from "./remote-compaction.ts";
import { createSessionCoordinator } from "./session-coordinator.ts";
import {
	estimateCompactionWindowPrefillTokens,
	FAILED_REQUEST_KIND,
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

function sanitizeCodexPayload(payload: JsonObject): JsonObject {
	const sanitized = structuredClone(payload);
	delete sanitized.prompt_cache_retention;
	return sanitized;
}

function isLegacyMigrationLimit(message: string): boolean {
	return message.startsWith("OpenAI Codex legacy compaction checkpoint cannot be migrated");
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
	const basePayloadBySession = new Map<string, JsonObject>();
	const turnStateBySession = new Map<string, string>();
	const warnedUnsupportedPayloadBySession = new Set<string>();
	const rememberTurnState = (sessionId: string, state: string): void => {
		if (!turnStateBySession.has(sessionId)) turnStateBySession.set(sessionId, state);
	};

	const coordinator = createSessionCoordinator({
		getBranch: (ctx) => ctx.sessionManager.getBranch() as SessionEntry[],
		getAllTools: () => pi.getAllTools(),
		createCheckpoint: ({ ctx, model, input, basePayload, signal }) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			return createNativeCheckpoint({
				ctx,
				model,
				input,
				basePayload: basePayload ?? basePayloadBySession.get(sessionId),
				turnState: turnStateBySession.get(sessionId),
				onTurnState: (state) => rememberTurnState(sessionId, state),
				signal,
				config,
				allTools: pi.getAllTools(),
				activeToolNames: pi.getActiveTools(),
			});
		},
		appendCheckpoint: (details) => pi.appendEntry(NATIVE_COMPACTION_KIND, details),
		appendFailedRequest: (details) => pi.appendEntry(FAILED_REQUEST_KIND, details),
		includeCompactionTrigger: (ctx) => loadConfig(ctx.cwd, ctx.isProjectTrusted()).remoteCompactionV2,
		shouldAutoCompact: ({ ctx, model, input, reason }) => {
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
				reason,
			});
		},
	});

	const clearTransient = () => {
		coordinator.clear();
		basePayloadBySession.clear();
		turnStateBySession.clear();
	};
	const clear = () => {
		clearTransient();
		warnedUnsupportedPayloadBySession.clear();
	};
	pi.on("session_start", clear);
	pi.on("session_shutdown", clear);
	pi.on("session_tree", clearTransient);
	const clearTurnState = (_event: unknown, ctx: { sessionManager: { getSessionId(): string } }) => {
		turnStateBySession.delete(ctx.sessionManager.getSessionId());
	};
	pi.on("turn_start", clearTurnState);
	pi.on("turn_end", clearTurnState);
	pi.on("model_select", async (event, ctx) => {
		await coordinator.selectModel(event, ctx);
	});

	pi.on("context", (event, ctx) => {
		if (!isOpenAICodexModel(ctx.model)) return undefined;
		const checkpoint = findNativeCheckpoint(ctx.sessionManager.getBranch() as SessionEntry[]);
		if (checkpoint.status !== "valid" && checkpoint.status !== "legacy") return undefined;
		return {
			messages: event.messages.filter((message) => message.role !== "compactionSummary"),
		};
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (!isOpenAICodexModel(ctx.model)) return;
		setFeatureHeader(event.headers, loadConfig(ctx.cwd, ctx.isProjectTrusted()).remoteCompactionV2);
		const turnState = turnStateBySession.get(ctx.sessionManager.getSessionId());
		if (turnState) event.headers["x-codex-turn-state"] = turnState;
	});

	pi.on("after_provider_response", (event, ctx) => {
		if (!isOpenAICodexModel(ctx.model)) return;
		const turnState = Object.entries(event.headers).find(([name]) => name.toLowerCase() === "x-codex-turn-state")?.[1];
		if (turnState) rememberTurnState(ctx.sessionManager.getSessionId(), turnState);
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const model = ctx.model;
		if (!isOpenAICodexModel(model) || !isJsonObject(event.payload)) return undefined;
		const sanitizedPayload = sanitizeCodexPayload(event.payload);
		const sessionId = ctx.sessionManager.getSessionId();
		if (Object.hasOwn(event.payload, "prompt_cache_retention")) {
			delete event.payload.prompt_cache_retention;
			if (ctx.hasUI && !warnedUnsupportedPayloadBySession.has(sessionId)) {
				warnedUnsupportedPayloadBySession.add(sessionId);
				ctx.ui.notify("OpenAI Codex does not support prompt_cache_retention; the setting was ignored.", "warning");
			}
		}
		const requestInput = Array.isArray(sanitizedPayload.input) ? sanitizedPayload.input : undefined;
		const basePayload = stripInputFromPayload(sanitizedPayload);
		basePayloadBySession.set(sessionId, basePayload);
		try {
			const input = await coordinator.prepareRequest(
				model,
				ctx,
				requestInput,
				basePayload,
			);
			if (!input) return sanitizedPayload;
			const payload = stripInputFromPayload(sanitizedPayload);
			payload.input = input;
			return payload;
		} catch (error) {
			coordinator.recordFailedRequest(ctx, requestInput);
			ctx.abort();
			if (ctx.hasUI) {
				const message = errorMessage(error);
				ctx.ui.notify(`OpenAI Codex request blocked: ${message}`, isLegacyMigrationLimit(message) ? "warning" : "error");
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
				event.reason === "overflow" && event.willRetry,
				event.signal,
			);
			const sessionId = ctx.sessionManager.getSessionId();
			const native = await createNativeCheckpoint({
				ctx,
				model,
				input,
				basePayload: basePayloadBySession.get(sessionId),
				turnState: turnStateBySession.get(sessionId),
				onTurnState: (state) => rememberTurnState(sessionId, state),
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

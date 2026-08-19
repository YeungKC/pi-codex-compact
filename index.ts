import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { shouldAutoCompact } from "./scheduler.ts";
import { autoCompactTokenLimit, loadConfig } from "./config.ts";
import { createNativeCheckpoint, type NativeCheckpointRequest } from "./remote-compaction.ts";
import { createSessionCoordinator } from "./session-coordinator.ts";
import {
	estimateCompactionWindowPrefillTokens,
	FAILED_REQUEST_KIND,
	findNativeCheckpoint,
	fullInputForBranch,
	isJsonObject,
	isOpenAICodexModel,
	mergeFeatureHeader,
	approximateResponseItemTokens,
	isContextWindowCompactionError,
	isRetryableCompactionError,
	approximateTokenCount,
	buildToolPayload,
	stripInputFromPayload,
	NATIVE_COMPACTION_KIND,
	type JsonObject,
	type ResponseItem,
} from "./native-compaction.ts";

const LOCAL_MARKER = "OpenAI Codex native compaction checkpoint.";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type BlockedAction = "retry" | "new-session" | "cancel";
type CompactionFailureAction = "context-overflow" | BlockedAction;
type BlockedRequestContext = {
	hasUI: boolean;
	signal?: AbortSignal;
	ui: {
		select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
		notify(message: string, type?: "info" | "warning" | "error"): void;
	};
};

async function chooseBlockedAction(
	ctx: BlockedRequestContext,
	error: unknown,
	signal?: AbortSignal,
): Promise<BlockedAction> {
	const message = errorMessage(error);
	const canRetry = isRetryableCompactionError(error);
	if (!ctx.hasUI) {
		console.warn(`OpenAI Codex request blocked: ${message}`);
		return "cancel";
	}
	const options = canRetry
		? ["Retry", "Start a new session", "Cancel"]
		: ["Start a new session", "Cancel"];
	let choice: string | undefined;
	try {
		choice = await ctx.ui.select("OpenAI Codex request blocked", options, { signal: signal ?? ctx.signal });
	} catch {
		return "cancel";
	}
	if (choice === "Retry") return "retry";
	if (choice === "Start a new session") return "new-session";
	return "cancel";
}

async function chooseCompactionFailureAction(
	ctx: BlockedRequestContext,
	error: unknown,
	recovery: "context-overflow" | undefined,
	signal?: AbortSignal,
): Promise<CompactionFailureAction> {
	if (recovery === undefined && isContextWindowCompactionError(error)) return "context-overflow";
	return chooseBlockedAction(ctx, error, signal);
}

function notifyBlocked(
	ctx: BlockedRequestContext,
	error: unknown,
	action: BlockedAction = "cancel",
): void {
	if (!ctx.hasUI) return;
	const message = errorMessage(error);
	const nextStep = action === "new-session" ? " Start a new session to continue." : "";
	ctx.ui.notify(`OpenAI Codex request blocked: ${message}.${nextStep}`, "error");
}

export default function codexCompactionExtension(pi: ExtensionAPI): void {
	const basePayloadBySession = new Map<string, JsonObject>();
	const turnStateBySession = new Map<string, string>();
	const rememberTurnState = (sessionId: string, state: string): void => {
		if (!turnStateBySession.has(sessionId)) turnStateBySession.set(sessionId, state);
	};
	const createCheckpoint = (params: Pick<NativeCheckpointRequest, "ctx" | "model" | "input" | "basePayload" | "signal">) => {
		const sessionId = params.ctx.sessionManager.getSessionId();
		return createNativeCheckpoint({
			...params,
			basePayload: params.basePayload ?? basePayloadBySession.get(sessionId),
			turnState: turnStateBySession.get(sessionId),
			onTurnState: (state) => rememberTurnState(sessionId, state),
			allTools: pi.getAllTools(),
			activeToolNames: pi.getActiveTools(),
		});
	};

	const coordinator = createSessionCoordinator({
		getBranch: (ctx) => ctx.sessionManager.getBranch() as SessionEntry[],
		getAllTools: () => pi.getAllTools(),
		createCheckpoint,
		appendCheckpoint: (details) => pi.appendEntry(NATIVE_COMPACTION_KIND, details),
		appendFailedRequest: (details) => pi.appendEntry(FAILED_REQUEST_KIND, details),
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
	pi.on("session_start", clearTransient);
	pi.on("session_shutdown", clearTransient);
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
		if (checkpoint.status !== "valid") return undefined;
		return {
			messages: event.messages.filter((message) => message.role !== "compactionSummary"),
		};
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (!isOpenAICodexModel(ctx.model)) return;
		const existingFeatureHeader = Object.entries(event.headers)
			.find(([name]) => name.toLowerCase() === "x-codex-beta-features");
		event.headers[existingFeatureHeader?.[0] ?? "x-codex-beta-features"] = mergeFeatureHeader(existingFeatureHeader?.[1]);
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
		delete event.payload.prompt_cache_retention;
		const sessionId = ctx.sessionManager.getSessionId();
		const requestInput = Array.isArray(event.payload.input) ? event.payload.input : undefined;
		const basePayload = stripInputFromPayload(event.payload);
		basePayloadBySession.set(sessionId, basePayload);
		let recovery: "context-overflow" | undefined;
		for (;;) {
			try {
				const input = await coordinator.prepareRequest(
					model,
					ctx,
					requestInput,
					basePayload,
					false,
					recovery,
				);
				if (!input) return event.payload;
				const payload = stripInputFromPayload(event.payload);
				payload.input = input;
				return payload;
			} catch (error) {
				if (ctx.signal?.aborted) return undefined;
				const action = await chooseCompactionFailureAction(ctx, error, recovery, ctx.signal);
				if (action === "context-overflow") {
					recovery = "context-overflow";
					continue;
				}
				if (action === "retry") {
					recovery = undefined;
					continue;
				}
				coordinator.recordFailedRequest(ctx, requestInput);
				ctx.abort();
				notifyBlocked(ctx, error, action);
				// The abort signal stops Pi's provider call. A synthetic `input: null`
				// would create a second protocol error.
				return undefined;
			}
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!model || !isOpenAICodexModel(model)) return undefined;
		const branch = event.branchEntries as SessionEntry[];
		const requestInput = fullInputForBranch({
			branch,
			model,
			tools: pi.getAllTools(),
		});
		const sessionId = ctx.sessionManager.getSessionId();
		const excludeLastAssistantError = event.reason === "overflow" && event.willRetry;
		let recovery: "context-overflow" | undefined;
		let native: Awaited<ReturnType<typeof createNativeCheckpoint>> | undefined;
		let input: ResponseItem[] | undefined;
		for (;;) {
			try {
				input = await coordinator.prepareCompaction(
					model,
					ctx,
					requestInput,
					excludeLastAssistantError,
					event.signal,
					recovery,
					basePayloadBySession.get(sessionId),
				);
				native = await createCheckpoint({
					ctx,
					model,
					input,
					basePayload: basePayloadBySession.get(sessionId),
					signal: event.signal,
				});
				break;
			} catch (error) {
				if (event.signal.aborted) return { cancel: true };
				const action = await chooseCompactionFailureAction(ctx, error, recovery, event.signal);
				if (action === "context-overflow") {
					recovery = "context-overflow";
					continue;
				}
				if (action === "retry") {
					recovery = undefined;
					continue;
				}
				if (!event.signal.aborted) notifyBlocked(ctx, error, action);
				return { cancel: true };
			}
		}
		if (event.signal.aborted || !native || !input) return { cancel: true };
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
	});

}

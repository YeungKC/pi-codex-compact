import { sessionEntryToContextMessages, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { shouldAutoCompact } from "./scheduler.ts";
import { autoCompactTokenLimit, loadConfig } from "./config.ts";
import { createNativeCheckpoint, type NativeCheckpointRequest } from "./remote-compaction.ts";
import { createSessionCoordinator, type RemoteCompactionReason } from "./session-coordinator.ts";
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
	compactionFailureClassification,
	approximateTokenCount,
	buildToolPayload,
	stripInputFromPayload,
	NATIVE_COMPACTION_KIND,
	type JsonObject,
	type ResponseItem,
} from "./native-compaction.ts";

const LOCAL_MARKER = "OpenAI Codex native compaction checkpoint.";
const AUTHENTICATION_FAILURE_CODE_PATTERN = /^(?:authentication|authentication_error|auth_error|authorization_error|credential_error|invalid_api_key|invalid_credential|invalid_token|expired_token|token_expired|unauthorized|forbidden|permission_denied|access_denied)$/;
const POLICY_OR_QUOTA_FAILURE_CODE_PATTERN = /^(?:policy_or_quota|policy_violation|insufficient_quota|quota_exceeded|usage_limit_(?:reached|exceeded)|usage_not_included|billing_(?:error|issue|required)|insufficient_funds|out_of_budget)$/;

type FailurePhase = "before_provider_request" | "session_before_compact";
type FailureOutcome = "request_aborted" | "compaction_cancelled";
type CompactionNoticeContext = {
	hasUI: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus(key: string, text: string | undefined): void;
	};
	sessionManager: { getSessionId(): string };
};

function failureNextStep(code: string, recoveryAttempted: boolean): string {
	if (code === "authentication" || AUTHENTICATION_FAILURE_CODE_PATTERN.test(code)) {
		return "check Codex authentication and retry manually";
	}
	if (code === "policy_or_quota" || POLICY_OR_QUOTA_FAILURE_CODE_PATTERN.test(code)) {
		return "check Codex plan, permissions, quota, and billing before retrying manually";
	}
	if (code === "context_window_exceeded" || recoveryAttempted) return "shorten the request or start a new session";
	if (code === "network" || code === "timeout") return "check the connection and retry manually";
	return "retry manually or start a new session";
}

function remoteCompactionReasonLabel(reason: RemoteCompactionReason): string {
	if (reason === "model-transition") return "model transition";
	if (reason === "context-overflow-recovery") return "context overflow recovery";
	if (reason === "context-recovery") return "context recovery";
	return reason;
}

function reportCompactionFailure(
	ctx: CompactionNoticeContext,
	model: { id?: unknown } | undefined,
	error: unknown,
	phase: FailurePhase,
	recoveryAttempted: boolean,
	outcome: FailureOutcome,
): string {
	const code = compactionFailureClassification(error);
	const modelId = typeof model?.id === "string" && /^[a-zA-Z0-9_.:-]{1,64}$/.test(model.id) ? model.id : "unknown";
	const notice = `OpenAI Codex failure: phase=${phase}; code=${code}; model=${modelId}; recoveryAttempted=${recoveryAttempted}; outcome=${outcome}; next=${failureNextStep(code, recoveryAttempted)}.`;
	if (ctx.hasUI) ctx.ui.notify(notice, "error");
	else console.error(notice);
	return code;
}

export default function codexCompactionExtension(pi: ExtensionAPI): void {
	const basePayloadBySession = new Map<string, JsonObject>();
	const turnStateBySession = new Map<string, string>();
	const pendingOverflowPresentationBySession = new Map<string, CompactionNoticeContext>();
	let lifecycleGeneration = 0;
	const rememberTurnState = (sessionId: string, state: string): void => {
		if (!turnStateBySession.has(sessionId)) turnStateBySession.set(sessionId, state);
	};
	const clearPendingOverflowPresentation = (ctx: CompactionNoticeContext): void => {
		if (!pendingOverflowPresentationBySession.delete(ctx.sessionManager.getSessionId())) return;
		if (ctx.hasUI) ctx.ui.setStatus("codex-compact", undefined);
	};
	const presentRemoteCompaction = async <T>(
		ctx: CompactionNoticeContext,
		reason: RemoteCompactionReason,
		operation: () => Promise<T>,
		completed: (result: T) => boolean = () => true,
	): Promise<T> => {
		const sessionId = ctx.sessionManager.getSessionId();
		const resumesOverflowRecovery = reason === "context-overflow-recovery"
			&& pendingOverflowPresentationBySession.has(sessionId);
		if (!resumesOverflowRecovery) clearPendingOverflowPresentation(ctx);
		const label = remoteCompactionReasonLabel(reason);
		if (ctx.hasUI) ctx.ui.setStatus("codex-compact", `Compacting context with Codex (${label})…`);
		let retainForOverflowRecovery = false;
		try {
			const result = await operation();
			if (ctx.hasUI && completed(result)) ctx.ui.notify(`Codex context compacted (${label}).`, "info");
			return result;
		} catch (error) {
			retainForOverflowRecovery = !resumesOverflowRecovery && isContextWindowCompactionError(error);
			if (retainForOverflowRecovery) pendingOverflowPresentationBySession.set(sessionId, ctx);
			throw error;
		} finally {
			if (!retainForOverflowRecovery) {
				pendingOverflowPresentationBySession.delete(sessionId);
				if (ctx.hasUI) ctx.ui.setStatus("codex-compact", undefined);
			}
		}
	};
	const createCheckpoint = (params: Pick<NativeCheckpointRequest, "ctx" | "model" | "input" | "basePayload" | "signal">) => {
		const lifecycleGenerationAtStart = lifecycleGeneration;
		const sessionId = params.ctx.sessionManager.getSessionId();
		return createNativeCheckpoint({
			...params,
			basePayload: params.basePayload ?? basePayloadBySession.get(sessionId),
			turnState: turnStateBySession.get(sessionId),
			onTurnState: (state) => {
				if (lifecycleGeneration === lifecycleGenerationAtStart) rememberTurnState(sessionId, state);
			},
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
			const supportsStrictMode = (model.compat as { supportsStrictMode?: boolean } | undefined)?.supportsStrictMode !== false;
			const estimatedStablePrefixTokens = approximateTokenCount({
				instructions: ctx.getSystemPrompt(),
				tools: buildToolPayload(pi.getAllTools(), pi.getActiveTools(), supportsStrictMode),
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
		runCompaction: (ctx, reason, operation) => presentRemoteCompaction(ctx, reason, operation),
	});

	const clearTransient = () => {
		lifecycleGeneration++;
		coordinator.clear();
		for (const ctx of pendingOverflowPresentationBySession.values()) {
			if (ctx.hasUI) ctx.ui.setStatus("codex-compact", undefined);
		}
		pendingOverflowPresentationBySession.clear();
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
	pi.on("model_select", (event, ctx) => coordinator.selectModel(event, ctx));

	pi.on("context", (event, ctx) => {
		if (!isOpenAICodexModel(ctx.model)) return undefined;
		const branch = ctx.sessionManager.getBranch() as SessionEntry[];
		const checkpoint = findNativeCheckpoint(branch);
		if (checkpoint.status === "invalid") {
			return {
				messages: branch.flatMap((entry) => entry.type === "compaction" ? [] : sessionEntryToContextMessages(entry)),
			};
		}
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
				if (ctx.signal?.aborted) {
					clearPendingOverflowPresentation(ctx);
					return undefined;
				}
				if (recovery === undefined && isContextWindowCompactionError(error)) {
					recovery = "context-overflow";
					continue;
				}
				const recoveryAttempted = recovery !== undefined;
				clearPendingOverflowPresentation(ctx);
				const code = reportCompactionFailure(
					ctx,
					model,
					error,
					"before_provider_request",
					recoveryAttempted,
					"request_aborted",
				);
				coordinator.recordFailedRequest(ctx, requestInput, {
					phase: "before_provider_request",
					code,
					recoveryAttempted,
				});
				ctx.abort();
				// The abort signal stops Pi's provider call. A synthetic `input: null`
				// would create a second protocol error.
				return undefined;
			}
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.model;
		if (!model || !isOpenAICodexModel(model)) return undefined;
		const reason: RemoteCompactionReason = event.reason === "manual"
			? "manual"
			: event.reason === "overflow" ? "context-overflow-recovery" : "automatic";
		return presentRemoteCompaction(ctx, reason, async () => {
			const lifecycleGenerationAtStart = lifecycleGeneration;
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
					if (lifecycleGeneration !== lifecycleGenerationAtStart) return { cancel: true };
					native = await createCheckpoint({
						ctx,
						model,
						input,
						signal: event.signal,
					});
					if (lifecycleGeneration !== lifecycleGenerationAtStart) return { cancel: true };
					break;
				} catch (error) {
					if (lifecycleGeneration !== lifecycleGenerationAtStart || event.signal.aborted) return { cancel: true };
					if (recovery === undefined && isContextWindowCompactionError(error)) {
						recovery = "context-overflow";
						continue;
					}
					reportCompactionFailure(
						ctx,
						model,
						error,
						"session_before_compact",
						recovery !== undefined,
						"compaction_cancelled",
					);
					return { cancel: true };
				}
			}
			if (lifecycleGeneration !== lifecycleGenerationAtStart || event.signal.aborted || !native || !input) return { cancel: true };
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
		}, (result) => "compaction" in result);
	});

}

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { CodexCompactionConfig } from "./config.ts";
import { compactionHash } from "./capabilities.ts";
import {
	buildCodexHeaders,
	buildCompactionRequestBody,
	buildLegacyCompactionRequestBody,
	buildReplacementHistory,
	buildToolPayload,
	callLegacyRemoteCompaction,
	callRemoteCompaction,
	filterLegacyCompactionHistory,
	modelKey,
	approximateResponseItemTokens,
	approximateTokenCount,
	markFallbackEligibility,
	type NativeCompactionDebugSink,
	NATIVE_COMPACTION_KIND,
	NATIVE_COMPACTION_VERSION,
	resolveCodexCompactUrl,
	resolveCodexResponsesUrl,
	trimFunctionCallHistoryToFitContextWindow,
	type JsonObject,
	type NativeCompactionDetails,
	type ResponseItem,
} from "./native-compaction.ts";

export type NativeCheckpointRequest = {
	ctx: ExtensionContext;
	model: Model<any>;
	input: ResponseItem[];
	basePayload?: JsonObject;
	signal?: AbortSignal;
	config: CodexCompactionConfig;
	allTools: Parameters<typeof buildToolPayload>[0];
	activeToolNames: string[];
	debug?: NativeCompactionDebugSink;
};

export type NativeCheckpointResult = {
	details: NativeCompactionDetails;
	usage?: Awaited<ReturnType<typeof callRemoteCompaction>>["usage"];
};

/**
 * Owns the remote protocol seam. The lifecycle adapter supplies session facts;
 * V1 and V2 remain internal adapters and both return the same checkpoint shape.
 */
export async function createNativeCheckpoint(params: NativeCheckpointRequest): Promise<NativeCheckpointResult> {
	const auth = await params.ctx.modelRegistry.getApiKeyAndHeaders(params.model);
	if (!auth.ok || !auth.apiKey) {
		const error = markFallbackEligibility(
			new Error(auth.ok ? "OpenAI Codex authentication is unavailable." : auth.error),
			false,
		);
		params.debug?.({
			phase: "failed",
			strategy: params.config.remoteCompactionV2 ? "v2" : "v1",
			model: modelKey(params.model),
			error: "authentication failed",
			retryWithCurrentModel: false,
		});
		throw error;
	}
	const sessionId = params.ctx.sessionManager.getSessionId();
	const baseUrl = auth.baseUrl ?? params.model.baseUrl;
	const generatedTools = buildToolPayload(params.allTools, params.activeToolNames);
	const tools = Array.isArray(params.basePayload?.tools) ? params.basePayload.tools : generatedTools;
	const instructions = typeof params.basePayload?.instructions === "string"
		? params.basePayload.instructions
		: params.ctx.getSystemPrompt();
	// Leave room for the stable request prefix and the V2 trigger item.
	const reservedTokens = approximateTokenCount({
		instructions,
		tools,
		...(params.config.remoteCompactionV2 ? { input: [{ type: "compaction_trigger" }] } : {}),
	});
	const input = trimFunctionCallHistoryToFitContextWindow(
		params.input,
		params.model.contextWindow,
		reservedTokens,
	);
	params.debug?.({
		phase: "input",
		strategy: params.config.remoteCompactionV2 ? "v2" : "v1",
		model: modelKey(params.model),
		inputItems: params.input.length,
		trimmedInputItems: input.length,
		estimatedInputTokens: approximateResponseItemTokens(input),
		reservedTokens,
		toolCount: Array.isArray(tools) ? tools.length : 0,
		toolTypes: Array.isArray(tools)
			? tools.flatMap((tool) => typeof tool === "object" && tool !== null && typeof (tool as { type?: unknown }).type === "string" ? [(tool as { type: string }).type] : [])
			: [],
	});
	const headers = buildCodexHeaders({
		apiKey: auth.apiKey,
		headers: auth.headers,
		sessionId,
		includeRemoteCompactionV2: params.config.remoteCompactionV2,
	});

	if (!params.config.remoteCompactionV2) {
		const remote = await callLegacyRemoteCompaction({
			url: resolveCodexCompactUrl(baseUrl),
			headers,
			body: buildLegacyCompactionRequestBody({
				basePayload: params.basePayload,
				model: params.model,
				input,
				instructions,
				tools,
				sessionId,
			}),
			model: params.model,
			signal: params.signal,
			onDebug: params.debug,
		});
		return {
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				strategy: "v1",
				modelKey: modelKey(params.model),
				...(compactionHash(params.model) ? { compHash: compactionHash(params.model) } : {}),
				replacementHistory: filterLegacyCompactionHistory(remote.replacementHistory),
			},
			usage: remote.usage,
		};
	}

	const body = buildCompactionRequestBody({
		basePayload: params.basePayload,
		model: params.model,
		input,
		instructions,
		tools,
		sessionId,
	});
	const remote = await callRemoteCompaction({
		url: resolveCodexResponsesUrl(baseUrl),
		headers,
		body,
		model: params.model,
		signal: params.signal,
		onDebug: params.debug,
	});
	return {
		details: {
			kind: NATIVE_COMPACTION_KIND,
			version: NATIVE_COMPACTION_VERSION,
			strategy: "v2",
			modelKey: modelKey(params.model),
			...(compactionHash(params.model) ? { compHash: compactionHash(params.model) } : {}),
			replacementHistory: buildReplacementHistory(input, remote.compactionItem),
		},
		usage: remote.usage,
	};
}

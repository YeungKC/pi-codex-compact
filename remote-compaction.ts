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
	approximateCompactionRequestTokens,
	approximateTokenCount,
	markContextOverflowRecovery,
	markFallbackEligibility,
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
	turnState?: string;
	onTurnState?: (turnState: string) => void;
	signal?: AbortSignal;
	config: CodexCompactionConfig;
	allTools: Parameters<typeof buildToolPayload>[0];
	activeToolNames: string[];
};

export type NativeCheckpointResult = {
	details: NativeCompactionDetails;
	usage?: Awaited<ReturnType<typeof callRemoteCompaction>>["usage"];
};

function compactionBasePayload(params: NativeCheckpointRequest): JsonObject {
	const base = params.basePayload ? structuredClone(params.basePayload) : {};
	const activeModel = params.ctx.model;
	const payloadModel = typeof base.model === "string" ? base.model : undefined;
	if (
		(activeModel && modelKey(activeModel) !== modelKey(params.model))
		|| (payloadModel !== undefined && payloadModel !== params.model.id)
	) {
		// A transition compacts with the previous model. Do not reuse settings
		// already mapped for the newly selected model.
		delete base.reasoning;
		delete base.service_tier;
		delete base.text;
		delete base.temperature;
	}
	if (!Object.hasOwn(base, "reasoning") && params.ctx.thinkingLevel) {
		const effort = params.model.thinkingLevelMap?.[params.ctx.thinkingLevel] ?? params.ctx.thinkingLevel;
		if (effort) base.reasoning = { effort, summary: "auto" };
	}
	return base;
}

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
		throw error;
	}
	const sessionId = params.ctx.sessionManager.getSessionId();
	const baseUrl = auth.baseUrl ?? params.model.baseUrl;
	const basePayload = compactionBasePayload(params);
	const generatedTools = buildToolPayload(params.allTools, params.activeToolNames);
	const tools = Array.isArray(basePayload.tools) ? basePayload.tools : generatedTools;
	const instructions = typeof basePayload.instructions === "string"
		? basePayload.instructions
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
	if (approximateCompactionRequestTokens({
		input,
		instructions,
		tools,
		includeTrigger: params.config.remoteCompactionV2,
	}) > params.model.contextWindow) {
		throw markContextOverflowRecovery(new Error(
			`OpenAI Codex compaction input exceeds this model's ${params.model.contextWindow} token context window after tool-output trimming.`,
		));
	}
	const headers = buildCodexHeaders({
		apiKey: auth.apiKey,
		headers: auth.headers,
		sessionId,
		turnState: params.turnState,
		includeRemoteCompactionV2: params.config.remoteCompactionV2,
	});

	if (!params.config.remoteCompactionV2) {
		const remote = await callLegacyRemoteCompaction({
			url: resolveCodexCompactUrl(baseUrl),
			headers,
			body: buildLegacyCompactionRequestBody({
				basePayload,
				model: params.model,
				input,
				instructions,
				tools,
				sessionId,
			}),
			model: params.model,
			signal: params.signal,
		});
		if (remote.turnState) params.onTurnState?.(remote.turnState);
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
		basePayload,
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
	});
	if (remote.turnState) params.onTurnState?.(remote.turnState);
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

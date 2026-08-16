import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { CodexCompactionConfig } from "./config.ts";
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
		throw new Error(auth.ok ? "OpenAI Codex authentication is unavailable." : auth.error);
	}
	const sessionId = params.ctx.sessionManager.getSessionId();
	const tools = buildToolPayload(params.allTools, params.activeToolNames);
	const input = trimFunctionCallHistoryToFitContextWindow(params.input, params.model.contextWindow);
	const headers = buildCodexHeaders({
		apiKey: auth.apiKey,
		headers: auth.headers,
		sessionId,
		includeRemoteCompactionV2: params.config.remoteCompactionV2,
	});

	if (!params.config.remoteCompactionV2) {
		const remote = await callLegacyRemoteCompaction({
			url: resolveCodexCompactUrl(params.model.baseUrl),
			headers,
			body: buildLegacyCompactionRequestBody({
				basePayload: params.basePayload,
				model: params.model,
				input,
				instructions: params.ctx.getSystemPrompt(),
				tools,
				sessionId,
			}),
			model: params.model,
			signal: params.signal,
		});
		return {
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				strategy: "v1",
				modelKey: modelKey(params.model),
				replacementHistory: filterLegacyCompactionHistory(remote.replacementHistory),
			},
			usage: remote.usage,
		};
	}

	const body = buildCompactionRequestBody({
		basePayload: params.basePayload,
		model: params.model,
		input,
		instructions: params.ctx.getSystemPrompt(),
		tools,
		sessionId,
	});
	const remote = await callRemoteCompaction({
		url: resolveCodexResponsesUrl(params.model.baseUrl),
		headers,
		body,
		model: params.model,
		signal: params.signal,
	});
	return {
		details: {
			kind: NATIVE_COMPACTION_KIND,
			version: NATIVE_COMPACTION_VERSION,
			strategy: "v2",
			modelKey: modelKey(params.model),
			replacementHistory: buildReplacementHistory(input, remote.compactionItem),
		},
		usage: remote.usage,
	};
}

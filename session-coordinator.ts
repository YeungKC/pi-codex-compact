import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { compactionHash } from "./capabilities.ts";
import {
	FAILED_REQUEST_KIND,
	effectiveInputForBranch,
	findNativeCheckpoint,
	fullInputForBranch,
	isFailClosedCompactionError,
	piContextInputForBranch,
	systemPromptInputForModel,
	isOpenAICodexModel,
	isJsonObject,
	modelKey,
	markContextOverflowRecovery,
	approximateCompactionRequestTokens,
	latestRemoteCompactionSuffix,
	type FailedRequestDetails,
	type JsonObject,
	type NativeCompactionDetails,
	type ResponseItem,
} from "./native-compaction.ts";

export type ModelSelectLike = {
	model: Model<any>;
	previousModel?: Model<any>;
};

export type CheckpointFactory = (params: {
	ctx: ExtensionContext;
	model: Model<any>;
	input: ReturnType<typeof effectiveInputForBranch>;
	basePayload?: JsonObject;
	signal?: AbortSignal;
}) => Promise<{ details: NativeCompactionDetails }>;

export type SessionCoordinatorDeps = {
	getBranch: (ctx: ExtensionContext) => SessionEntry[];
	getAllTools: () => Parameters<typeof effectiveInputForBranch>[0]["tools"];
	createCheckpoint: CheckpointFactory;
	appendCheckpoint: (details: NativeCompactionDetails) => void;
	appendFailedRequest?: (details: FailedRequestDetails) => void;
	shouldAutoCompact?: (params: {
		ctx: ExtensionContext;
		model: Model<any>;
		input: ResponseItem[];
		reason?: "automatic" | "downshift";
	}) => boolean;
};

type PendingTransition = {
	previousModel: Model<any>;
	targetModelKey: string;
	reason: "hash" | "downshift";
};

function isModelDownshift(previousModel: Model<any>, currentModel: Model<any>): boolean {
	return modelKey(previousModel) !== modelKey(currentModel)
		&& typeof previousModel.contextWindow === "number"
		&& typeof currentModel.contextWindow === "number"
		&& previousModel.contextWindow > currentModel.contextWindow;
}

function hashesDiffer(previousHash: string | undefined, currentHash: string | undefined): boolean {
	return previousHash !== undefined && currentHash !== undefined && previousHash !== currentHash;
}

function needsTransitionCompaction(previousModel: Model<any>, currentModel: Model<any>): boolean {
	return hashesDiffer(compactionHash(previousModel), compactionHash(currentModel));
}

function shouldRetryWithCurrentModel(error: unknown): boolean {
	if (typeof error === "object" && error !== null && "retryWithCurrentModel" in error) {
		return (error as { retryWithCurrentModel?: unknown }).retryWithCurrentModel === true;
	}
	const message = error instanceof Error ? error.message : String(error);
	if (isFailClosedCompactionError(message) || /(?:auth|account|invalid compaction)/i.test(message)) return false;
	return /(?:\b(?:400|403|408|409|429|5\d\d)\b|invalid request|unexpected status|context window|context_length_exceeded|invalid_prompt|usage limit|server overloaded|internal server|retry limit)/i.test(message);
}

function contextOverflowRecoveryError(model: Model<any>): Error {
	return markContextOverflowRecovery(new Error(
		`OpenAI Codex context overflow recovery could not keep a complete history turn within this model's ${model.contextWindow} token context window. Shorten the current request or start a new session.`,
	));
}

function compactionRequestReservedTokens(
	ctx: Pick<ExtensionContext, "getSystemPrompt">,
	basePayload: JsonObject | undefined,
	tools: unknown[],
): number {
	return approximateCompactionRequestTokens({
		input: [],
		instructions: typeof basePayload?.instructions === "string" ? basePayload.instructions : ctx.getSystemPrompt(),
		tools: Array.isArray(basePayload?.tools) ? basePayload.tools : tools,
		includeTrigger: true,
	});
}

function conversationLeafId(branch: SessionEntry[]): string | undefined {
	return [...branch].reverse().find((entry) => entry.type !== "custom")?.id;
}

function activeFailedRequest(branch: SessionEntry[]): FailedRequestDetails | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== FAILED_REQUEST_KIND || !isJsonObject(entry.data)) continue;
		if (typeof entry.data.entryId !== "string") return undefined;
		const resolved = branch.slice(index + 1).some((candidate) =>
			candidate.type === "message"
				&& candidate.message.role === "assistant"
				&& candidate.message.stopReason !== "error"
				&& candidate.message.stopReason !== "aborted",
		);
		return resolved
			? undefined
			: {
					kind: FAILED_REQUEST_KIND,
					entryId: entry.data.entryId,
					content: structuredClone(entry.data.content),
				};
	}
	return undefined;
}

function branchWithoutFailedRequest(branch: SessionEntry[], failed: FailedRequestDetails | undefined): SessionEntry[] {
	return failed ? branch.filter((entry) => entry.id !== failed.entryId) : branch;
}

function requestInputWithoutFailedRequest(
	requestInput: ResponseItem[] | undefined,
	failed: FailedRequestDetails | undefined,
): ResponseItem[] | undefined {
	if (!requestInput || !failed) return requestInput;
	const lastUserIndex = requestInput.findLastIndex((item) => item.role === "user");
	if (lastUserIndex < 0) return requestInput;
	const failedIndex = requestInput.findLastIndex((item, index) =>
		index < lastUserIndex
			&& item.role === "user"
			&& isDeepStrictEqual(item.content, failed.content),
	);
	return failedIndex < 0
		? requestInput
		: requestInput.filter((_item, index) => index !== failedIndex);
}

function hasBranchTailAfterCheckpoint(branch: SessionEntry[]): boolean {
	const checkpoint = findNativeCheckpoint(branch);
	return checkpoint.status !== "valid"
		|| branch.slice(checkpoint.checkpoint.entryIndex + 1).some(isContextEntry);
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(textContent).join("");
	if (!isJsonObject(value)) return "";
	if (value.type === "image") {
		return `[image:${typeof value.mimeType === "string" ? value.mimeType : ""}:${typeof value.data === "string" ? value.data : ""}]`;
	}
	if (value.type === "input_image" || value.type === "image_url") {
		const url = typeof value.image_url === "string" ? value.image_url : "";
		const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
		return match ? `[image:${match[1]}:${match[2]}]` : `[image-url:${url}]`;
	}
	if (typeof value.text === "string") return value.text;
	return Object.values(value).map(textContent).join("");
}

function messageContent(entry: Extract<SessionEntry, { type: "message" }>): unknown {
	return (entry.message as unknown as JsonObject).content;
}

function isContextEntry(entry: SessionEntry): boolean {
	return entry.type === "message" || entry.type === "custom_message";
}

function branchBeforeCurrentUser(branch: SessionEntry[], requestInput: ResponseItem[] | undefined): SessionEntry[] {
	const requestUser = requestInput?.findLast((item) => item.role === "user");
	const branchUserCount = branch.filter((entry) =>
		(entry.type === "message" && entry.message.role === "user") || entry.type === "custom_message",
	).length;
	const requestUserCount = requestInput?.filter((item) => item.role === "user").length ?? 0;
	if (requestUserCount > branchUserCount) return branch;
	const currentUserIndex = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user");
	const currentUser = currentUserIndex >= 0 ? branch[currentUserIndex] : undefined;
	if (!requestUser || !currentUser || currentUser.type !== "message") return branch;
	if (branch.slice(currentUserIndex + 1).some(isContextEntry)) return branch;
	return textContent(messageContent(currentUser)) === textContent(requestUser.content)
		? branch.filter((_entry, index) => index !== currentUserIndex)
		: branch;
}

function checkpointPreservedCurrentUser(branch: SessionEntry[], requestInput: ResponseItem[] | undefined): ResponseItem | undefined {
	const checkpoint = findNativeCheckpoint(branch);
	if (checkpoint.status !== "valid" || branch.slice(checkpoint.checkpoint.entryIndex + 1).some(isContextEntry)) return undefined;
	const checkpointUsers = [
		...checkpoint.checkpoint.details.replacementHistory,
		...(checkpoint.checkpoint.details.preservedInput ?? []),
	].filter((item) => item.role === "user");
	const requestUserCount = requestInput?.filter((item) => item.role === "user").length ?? 0;
	if (requestUserCount > checkpointUsers.length) return undefined;
	const requestUser = requestInput?.findLast((item) => item.role === "user");
	const checkpointUser = checkpointUsers.findLast((item) => item.role === "user");
	return requestUser && checkpointUser && isDeepStrictEqual(checkpointUser.content, requestUser.content) ? checkpointUser : undefined;
}

function preserveCurrentUser(
	details: NativeCompactionDetails,
	branch: SessionEntry[],
	requestInput: ResponseItem[] | undefined,
	alreadyPreserved = false,
): NativeCompactionDetails {
	const requestUser = requestInput?.findLast((item) => item.role === "user");
	const currentUser = branch.findLast((entry) => entry.type === "message" && entry.message.role === "user");
	if (!requestUser || !currentUser || currentUser.type !== "message") return details;
	if (alreadyPreserved && details.replacementHistory.some((item) => item.role === "user" && isDeepStrictEqual(item.content, requestUser.content))) return details;
	const compactedBranch = branchBeforeCurrentUser(branch, requestInput);
	if (compactedBranch.length < branch.length) return appendPreservedInput(details, [requestUser]);
	if (details.replacementHistory.some((item) => item.role === "user" && isDeepStrictEqual(item.content, requestUser.content))) return details;
	return textContent(messageContent(currentUser)) === textContent(requestUser.content)
		? appendPreservedInput(details, [requestUser])
		: details;
}

function rebindCheckpoint(details: NativeCompactionDetails, modelKeyValue: string, compHash: string | undefined): NativeCompactionDetails {
	const { compHash: _previousHash, ...withoutHash } = details;
	return {
		...withoutHash,
		modelKey: modelKeyValue,
		...(compHash ? { compHash } : {}),
	};
}

function withoutLastUser(items: ResponseItem[]): ResponseItem[] {
	const lastUserIndex = items.findLastIndex((item) => item.role === "user");
	return lastUserIndex < 0 ? items : items.filter((_item, index) => index !== lastUserIndex);
}

function preserveRequestUser(details: NativeCompactionDetails, requestInput: ResponseItem[]): NativeCompactionDetails {
	const requestUser = requestInput.findLast((item) => item.role === "user");
	return requestUser ? appendPreservedInput(details, [requestUser]) : details;
}

function appendPreservedInput(details: NativeCompactionDetails, input: ResponseItem[]): NativeCompactionDetails {
	return {
		...details,
		preservedInput: [...(details.preservedInput ?? []), ...input.map((item) => structuredClone(item))],
	};
}

function ensureNotAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("Compaction aborted.");
}

function sameUserOccurrence(left: ResponseItem, right: ResponseItem): boolean {
	const leftId = typeof left.id === "string" ? left.id : undefined;
	const rightId = typeof right.id === "string" ? right.id : undefined;
	if (leftId !== undefined || rightId !== undefined) return leftId !== undefined && leftId === rightId;
	return isDeepStrictEqual(left.content, right.content);
}

function requestTail(
	requestInput: ResponseItem[] | undefined,
	prefixes: ResponseItem[][],
	systemPromptInput: ResponseItem[],
): ResponseItem[] {
	if (!requestInput) return [];
	const candidates = prefixes.flatMap((value) => systemPromptInput.length > 0 ? [value, [...systemPromptInput, ...value]] : [value]);
	for (const prefix of candidates) {
		if (requestInput.length < prefix.length) continue;
		if (prefix.every((item, index) => isDeepStrictEqual(item, requestInput[index]!))) {
			return requestInput.slice(prefix.length);
		}
	}
	throw new Error("The Codex request changed before model-transition compaction completed.");
}

function resolveModel(ctx: ExtensionContext, key: string): Model<any> | undefined {
	const parts = key.split(":");
	if (parts.length < 3) return undefined;
	const model = ctx.modelRegistry.find(parts[0]!, parts.slice(2).join(":"));
	return model && modelKey(model) === key ? model : undefined;
}

function pendingTransitionFromBranch(
	branch: SessionEntry[],
	currentModel: Model<any>,
	ctx: ExtensionContext,
): PendingTransition | undefined {
	const selectedIndex = branch.findLastIndex((entry) =>
		entry.type === "model_change" && entry.provider === currentModel.provider && entry.modelId === currentModel.id,
	);
	const historyEnd = selectedIndex >= 0 ? selectedIndex : branch.length;
	if (selectedIndex >= 0 && branch.slice(selectedIndex + 1).some((entry) => entry.type === "message" && entry.message.role === "assistant")) return undefined;
	const previousAssistant = branch.slice(0, historyEnd).findLast((entry) => {
		if (entry.type !== "message") return false;
		const message = entry.message as unknown as JsonObject;
		return message.role === "assistant"
			&& typeof message.provider === "string"
			&& typeof message.api === "string"
			&& typeof message.model === "string";
	});
	if (!previousAssistant || previousAssistant.type !== "message") return undefined;
	const previousMessage = previousAssistant.message as unknown as JsonObject;
	const previousModel = resolveModel(ctx, modelKey({
		provider: previousMessage.provider as string,
		api: previousMessage.api as string,
		id: previousMessage.model as string,
	}));
	if (!previousModel || !isOpenAICodexModel(previousModel)) return undefined;
	const hashTransition = needsTransitionCompaction(previousModel, currentModel);
	if (!hashTransition && !isModelDownshift(previousModel, currentModel)) return undefined;
	return {
		previousModel,
		targetModelKey: modelKey(currentModel),
		reason: hashTransition ? "hash" : "downshift",
	};
}

export function createSessionCoordinator(deps: SessionCoordinatorDeps) {
	const rawGetBranch = deps.getBranch;
	deps = {
		...deps,
		getBranch: (ctx) => {
			const branch = rawGetBranch(ctx);
			return branchWithoutFailedRequest(branch, activeFailedRequest(branch));
		},
	};
	const pendingBySession = new Map<string, PendingTransition>();
	const transitionBySession = new Map<string, Promise<void>>();
	const automaticCompactionBySession = new Map<string, Promise<void>>();
	let generation = 0;

	const clear = (): void => {
		generation++;
		pendingBySession.clear();
		transitionBySession.clear();
		automaticCompactionBySession.clear();
	};

	const recordFailedRequest = (ctx: ExtensionContext, requestInput: ResponseItem[] | undefined): void => {
		const requestUser = requestInput?.findLast((item) => item.role === "user");
		if (!requestUser) return;
		const entry = rawGetBranch(ctx).findLast((candidate) =>
			candidate.type === "message"
				&& candidate.message.role === "user"
				&& textContent(candidate.message.content) === textContent(requestUser.content),
		);
		if (!entry) return;
		deps.appendFailedRequest?.({
			kind: FAILED_REQUEST_KIND,
			entryId: entry.id,
			content: structuredClone(requestUser.content),
		});
	};

	const runTransition = async (
		sessionId: string,
		ctx: ExtensionContext,
		previousModel: Model<any>,
		targetModelKey: string,
		currentModel: Model<any>,
		basePayload: JsonObject | undefined,
		startGeneration: number,
		requestInput: ResponseItem[] | undefined,
		excludeLastAssistantError = false,
		signal?: AbortSignal,
	): Promise<void> => {
		const operationSignal = signal ?? ctx.signal;
		for (let attempt = 0; attempt < 3; attempt++) {
			const branch = deps.getBranch(ctx);
			const leafId = conversationLeafId(branch);
			const compactionBranch = branchBeforeCurrentUser(branch, requestInput);
			const input = effectiveInputForBranch({
				branch: compactionBranch,
				model: previousModel,
				tools: deps.getAllTools(),
				allowCheckpointModelMismatch: true,
				excludeLastAssistantError,
			});
			let native: Awaited<ReturnType<CheckpointFactory>>;
			try {
				native = await deps.createCheckpoint({
					ctx,
					model: previousModel,
					input,
					basePayload,
					signal: operationSignal,
				});
			} catch (firstError) {
				if (
					(modelKey(currentModel) === modelKey(previousModel) && compactionHash(currentModel) === compactionHash(previousModel))
					|| !shouldRetryWithCurrentModel(firstError)
				) throw firstError;
				try {
					native = await deps.createCheckpoint({
						ctx,
						model: currentModel,
						input: effectiveInputForBranch({
							branch: compactionBranch,
							model: currentModel,
							tools: deps.getAllTools(),
							allowCheckpointModelMismatch: true,
							excludeLastAssistantError,
						}),
						basePayload,
						signal: operationSignal,
					});
				} catch {
					throw firstError;
				}
			}
			ensureNotAborted(operationSignal);
			if (generation !== startGeneration || conversationLeafId(deps.getBranch(ctx)) !== leafId) continue;
			deps.appendCheckpoint(rebindCheckpoint(
				preserveCurrentUser(native.details, branch, requestInput),
				targetModelKey,
				compactionHash(currentModel),
			));
			pendingBySession.delete(sessionId);
			return;
		}
		throw new Error("The session changed while Codex model-transition compaction was running.");
	};

	const recoverRequestAfterContextOverflow = async (
		model: Model<any>,
		ctx: ExtensionContext,
		requestInput: ResponseItem[] | undefined,
		basePayload?: JsonObject,
		signal?: AbortSignal,
	): Promise<ResponseItem[]> => {
		if (!requestInput) throw contextOverflowRecoveryError(model);
		const sessionId = ctx.sessionManager.getSessionId();
		const branch = deps.getBranch(ctx);
		const checkpoint = findNativeCheckpoint(branch);
		const pending = pendingBySession.get(sessionId);
		const checkpointModel = checkpoint.status === "valid"
			? resolveModel(ctx, checkpoint.checkpoint.details.modelKey)
			: undefined;
		const compactionModel = pending?.previousModel
			?? (checkpointModel && isOpenAICodexModel(checkpointModel) ? checkpointModel : model);
		const lastUserIndex = requestInput.findLastIndex((item) => item.role === "user");
		const historyInput = lastUserIndex >= 0 ? requestInput.slice(0, lastUserIndex) : requestInput;
		const reservedTokens = compactionRequestReservedTokens(ctx, basePayload, deps.getAllTools());
		const input = latestRemoteCompactionSuffix(historyInput, compactionModel.contextWindow, reservedTokens);
		if (input.length === 0) throw contextOverflowRecoveryError(compactionModel);
		const leafId = conversationLeafId(branch);
		const startGeneration = generation;
		const native = await deps.createCheckpoint({ ctx, model: compactionModel, input, basePayload, signal: signal ?? ctx.signal });
		ensureNotAborted(signal ?? ctx.signal);
		if (generation !== startGeneration || conversationLeafId(deps.getBranch(ctx)) !== leafId) {
			throw new Error("The session changed while Codex context overflow recovery was running.");
		}
		const preservedInput = lastUserIndex >= 0 ? requestInput.slice(lastUserIndex) : [];
		const details = rebindCheckpoint(
			appendPreservedInput(native.details, preservedInput),
			modelKey(model),
			compactionHash(model),
		);

		deps.appendCheckpoint(details);
		pendingBySession.delete(ctx.sessionManager.getSessionId());
		return [
			...details.replacementHistory,
			...(details.preservedInput ?? []),
		];
	};

	const recoverCurrentModel = async (
		model: Model<any>,
		ctx: ExtensionContext,
		basePayload?: JsonObject,
		requestInput?: ResponseItem[],
		forceDownshift = false,
		excludeLastAssistantError = false,
		signal?: AbortSignal,
	): Promise<void> => {
		if (!isOpenAICodexModel(model)) return;
		const operationSignal = signal ?? ctx.signal;
		const sessionId = ctx.sessionManager.getSessionId();
		const checkpoint = findNativeCheckpoint(deps.getBranch(ctx));
		if (checkpoint.status !== "valid") return;
		const pending = transitionBySession.get(sessionId);
		if (pending) {
			await pending.catch(() => undefined);
			return;
		}
		const previousModel = resolveModel(ctx, checkpoint.checkpoint.details.modelKey);
		const previousHash = checkpoint.checkpoint.details.compHash;
		const currentHash = compactionHash(model);
		const hashTransition = hashesDiffer(previousHash, currentHash);
		const downshift = previousModel ? isModelDownshift(previousModel, model) : false;
		if (!hashTransition && !downshift) return;
		if (!hashTransition && !forceDownshift) {
			const input = effectiveInputForBranch({
				branch: branchBeforeCurrentUser(deps.getBranch(ctx), requestInput),
				model,
				tools: deps.getAllTools(),
				allowCheckpointModelMismatch: true,
				excludeLastAssistantError,
			});
			if (deps.shouldAutoCompact?.({ ctx, model, input, reason: "downshift" }) !== true) return;
		}
		const startGeneration = generation;
		const transition = previousModel
			? runTransition(sessionId, ctx, previousModel, modelKey(model), model, basePayload, startGeneration, requestInput, excludeLastAssistantError, operationSignal)
			: (async () => {
					const branch = deps.getBranch(ctx);
					const leafId = conversationLeafId(branch);
					const native = await deps.createCheckpoint({
						ctx,
						model,
						input: effectiveInputForBranch({
							branch: branchBeforeCurrentUser(branch, requestInput),
							model,
							tools: deps.getAllTools(),
							allowCheckpointModelMismatch: true,
							excludeLastAssistantError,
						}),
						basePayload,
						signal: operationSignal,
					});
					ensureNotAborted(operationSignal);
					if (generation !== startGeneration || conversationLeafId(deps.getBranch(ctx)) !== leafId) {
						throw new Error("The session changed while Codex model-transition compaction was running.");
					}
					deps.appendCheckpoint(rebindCheckpoint(
						preserveCurrentUser(native.details, branch, requestInput),
						modelKey(model),
						currentHash,
					));
				})();
		transitionBySession.set(sessionId, transition);
		try {
			await transition;
		} finally {
			if (transitionBySession.get(sessionId) === transition) transitionBySession.delete(sessionId);
		}
	};

	const selectModel = async (event: ModelSelectLike, ctx: ExtensionContext): Promise<void> => {
		const sessionId = ctx.sessionManager.getSessionId();
		const previousModel = event.previousModel;
		if (!isOpenAICodexModel(event.model) || !previousModel) {
			pendingBySession.delete(sessionId);
			return;
		}
		if (!isOpenAICodexModel(previousModel)) {
			pendingBySession.delete(sessionId);
			return;
		}
		const pending = pendingBySession.get(sessionId);
		const transitionPreviousModel = pending?.previousModel ?? previousModel;
		const hashTransition = needsTransitionCompaction(transitionPreviousModel, event.model);
		const downshift = isModelDownshift(transitionPreviousModel, event.model);
		if (!hashTransition && !downshift) {
			pendingBySession.delete(sessionId);
			return;
		}
		if (
			pending
			&& modelKey(event.model) === modelKey(pending.previousModel)
			&& compactionHash(event.model) === compactionHash(pending.previousModel)
		) {
			pendingBySession.delete(sessionId);
			return;
		}
		pendingBySession.set(sessionId, {
			previousModel: pending?.previousModel ?? previousModel,
			targetModelKey: modelKey(event.model),
			reason: hashTransition ? "hash" : "downshift",
		});
	};

	const prepareRequest = async (
		model: Model<any>,
		ctx: ExtensionContext,
		requestInput: ResponseItem[] | undefined,
		basePayload?: JsonObject,
		skipAutomaticCompaction = false,
		recovery?: "context-overflow",
	): Promise<ResponseItem[] | undefined> => {
		const sessionId = ctx.sessionManager.getSessionId();
		requestInput = requestInputWithoutFailedRequest(requestInput, activeFailedRequest(rawGetBranch(ctx)));
		if (recovery === "context-overflow") {
			return recoverRequestAfterContextOverflow(model, ctx, requestInput, basePayload, ctx.signal);
		}
		let transitionCompactionCompleted = false;
		const activeTransition = transitionBySession.get(sessionId);
		if (activeTransition) {
			await activeTransition;
			return prepareRequest(model, ctx, requestInput, basePayload, false);
		}
		const branchBefore = deps.getBranch(ctx);
		let pending = pendingBySession.get(sessionId);
		const checkpoint = findNativeCheckpoint(branchBefore);
		if (!pending && checkpoint.status === "none") {
			const recoveredTransition = pendingTransitionFromBranch(branchBefore, model, ctx);
			pending = recoveredTransition;
			if (pending) pendingBySession.set(sessionId, pending);
		}
		if (
			pending
			&& checkpoint.status === "valid"
			&& checkpoint.checkpoint.details.modelKey === modelKey(model)
		) {
			pendingBySession.delete(sessionId);
			pending = undefined;
		}
		const checkpointModelKey = checkpoint.status === "valid"
			? checkpoint.checkpoint.details.modelKey
			: undefined;
		if (pending && pending.targetModelKey !== modelKey(model)) {
			throw new Error("The pending Codex model transition targets a different model.");
		}
		if (!requestInput && (pending || checkpoint.status === "valid")) {
			throw new Error("The Codex request input is unavailable while replaying compaction state.");
		}
		const historyModel = pending?.previousModel
			?? (checkpointModelKey && checkpointModelKey !== modelKey(model) ? resolveModel(ctx, checkpointModelKey) : undefined)
			?? model;
		const tools = deps.getAllTools();
		const historyBranch = branchBeforeCurrentUser(branchBefore, requestInput);
		const historyInput = effectiveInputForBranch({
			branch: historyBranch,
			model: historyModel,
			tools,
			allowCheckpointModelMismatch: true,
		});
		const rawHistoryInput = fullInputForBranch({ branch: historyBranch, model: historyModel, tools });
		const piContextInput = piContextInputForBranch({ branch: historyBranch, model: historyModel, tools });
		const currentHistoryInput = effectiveInputForBranch({
			branch: historyBranch,
			model,
			tools,
			allowCheckpointModelMismatch: true,
		});
		const currentRawHistoryInput = fullInputForBranch({ branch: historyBranch, model, tools });
		const currentPiContextInput = piContextInputForBranch({ branch: historyBranch, model, tools });
		const systemPromptInput = systemPromptInputForModel(model, ctx.getSystemPrompt());
		let tail: ResponseItem[];
		try {
			tail = requestTail(
				requestInput,
				[historyInput, piContextInput, rawHistoryInput, currentHistoryInput, currentPiContextInput, currentRawHistoryInput],
				systemPromptInput,
			);
		} catch (error) {
			if (!pending && checkpoint.status !== "valid") return undefined;
			const compactionInput = withoutLastUser(requestInput!);
			const createCheckpointFor = (selectedModel: Model<any>) => deps.createCheckpoint({
				ctx,
				model: selectedModel,
				input: compactionInput,
				basePayload,
				signal: ctx.signal,
			});
			let native: Awaited<ReturnType<CheckpointFactory>>;
			try {
				native = await createCheckpointFor(historyModel);
			} catch (firstError) {
				if (
					(modelKey(model) === modelKey(historyModel) && compactionHash(model) === compactionHash(historyModel))
					|| !shouldRetryWithCurrentModel(firstError)
				) throw firstError;
				try {
					native = await createCheckpointFor(model);
				} catch {
					throw firstError;
				}
			}
			ensureNotAborted(ctx.signal);
			const details = rebindCheckpoint(
				preserveRequestUser(native.details, requestInput!),
				modelKey(model),
				compactionHash(model),
			);
			deps.appendCheckpoint(details);
			pendingBySession.delete(sessionId);
			return [...details.replacementHistory, ...(details.preservedInput ?? [])];
		}


		const activeAutomaticCompaction = automaticCompactionBySession.get(sessionId);
		if (activeAutomaticCompaction) {
			await activeAutomaticCompaction;
			return prepareRequest(model, ctx, requestInput, basePayload, true);
		}
		if (pending && pending.targetModelKey === modelKey(model)) {
			const shouldRun = pending.reason === "hash"
				|| deps.shouldAutoCompact?.({ ctx, model, input: currentHistoryInput, reason: pending.reason }) === true;
			if (!shouldRun) {
				pendingBySession.delete(sessionId);
			} else {
				const startGeneration = generation;
				const transition = runTransition(sessionId, ctx, pending.previousModel, pending.targetModelKey, model, basePayload, startGeneration, requestInput);
				transitionBySession.set(sessionId, transition);
				try {
					await transition;
					transitionCompactionCompleted = true;
				} finally {
					if (transitionBySession.get(sessionId) === transition) transitionBySession.delete(sessionId);
				}
				skipAutomaticCompaction = false;
			}
		}

		await recoverCurrentModel(model, ctx, basePayload, requestInput);
		const recoveredCheckpoint = findNativeCheckpoint(deps.getBranch(ctx));
		if (recoveredCheckpoint.status === "valid" && recoveredCheckpoint.checkpoint.details.modelKey !== modelKey(model)) {
			const checkpointHash = recoveredCheckpoint.checkpoint.details.compHash;
			if (hashesDiffer(checkpointHash, compactionHash(model))) {
				throw new Error("The latest Codex compaction checkpoint requires model-transition compaction first.");
			}
		}
		let branch = deps.getBranch(ctx);
		{
			const activeTransition = transitionBySession.get(sessionId);
			if (activeTransition) {
				await activeTransition;
				return prepareRequest(model, ctx, requestInput, basePayload, false);
			}
			const activeAutomaticCompaction = automaticCompactionBySession.get(sessionId);
			if (activeAutomaticCompaction) {
				await activeAutomaticCompaction;
			} else if (!skipAutomaticCompaction) {
				const compactionBranch = branchBeforeCurrentUser(branch, requestInput);
				const currentHistory = effectiveInputForBranch({
					branch: compactionBranch,
					model,
					tools: deps.getAllTools(),
					allowCheckpointModelMismatch: true,
				});
				if (
					(transitionCompactionCompleted || hasBranchTailAfterCheckpoint(compactionBranch))
					&& deps.shouldAutoCompact?.({ ctx, model, input: currentHistory })
				) {
					const startGeneration = generation;
					const leafId = conversationLeafId(branch);
					const automaticCompaction = deps.createCheckpoint({
						ctx,
						model,
						input: currentHistory,
						basePayload,
						signal: ctx.signal,
					}).then((native) => {
						ensureNotAborted(ctx.signal);
						if (generation !== startGeneration || conversationLeafId(deps.getBranch(ctx)) !== leafId) {
							throw new Error("The session changed while Codex automatic compaction was running.");
						}
						deps.appendCheckpoint(preserveCurrentUser(
							native.details,
							branch,
							requestInput,
							checkpointPreservedCurrentUser(branch, requestInput) !== undefined,
						));
					});
					automaticCompactionBySession.set(sessionId, automaticCompaction);
					try {
						await automaticCompaction;
					} finally {
						if (automaticCompactionBySession.get(sessionId) === automaticCompaction) automaticCompactionBySession.delete(sessionId);
					}
				}
			}
			branch = deps.getBranch(ctx);
		}
		const currentCheckpoint = findNativeCheckpoint(branch);
		if (currentCheckpoint.status !== "valid") return undefined;
		const preservedUser = checkpointPreservedCurrentUser(branch, requestInput);
		if (preservedUser) {
			const preservedUserIndex = tail.findLastIndex((item) =>
				item.role === "user" && sameUserOccurrence(item, preservedUser),
			);
			if (preservedUserIndex >= 0) tail = tail.filter((_item, index) => index !== preservedUserIndex);
		}
		return [
			...effectiveInputForBranch({
				branch: branchBeforeCurrentUser(branch, requestInput),
				model,
				tools: deps.getAllTools(),
				allowCheckpointModelMismatch: true,
			}),
			...tail,
		];
	};

	const prepareCompaction = async (
		model: Model<any>,
		ctx: ExtensionContext,
		requestInput?: ResponseItem[],
		excludeLastAssistantError = false,
		signal?: AbortSignal,
		recovery?: "context-overflow",
		basePayload?: JsonObject,
	): Promise<ResponseItem[]> => {
		if (!isOpenAICodexModel(model)) return [];
		requestInput = requestInputWithoutFailedRequest(requestInput, activeFailedRequest(rawGetBranch(ctx)));
		const operationSignal = signal ?? ctx.signal;
		const sessionId = ctx.sessionManager.getSessionId();
		const activeTransition = transitionBySession.get(sessionId);
		if (activeTransition) await activeTransition;
		ensureNotAborted(operationSignal);
		if (recovery === "context-overflow") {
			if (!requestInput) throw contextOverflowRecoveryError(model);
			let recoveryInput = requestInput;
			if (excludeLastAssistantError) {
				const lastAssistantIndex = recoveryInput.findLastIndex((item) => item.role === "assistant");
				if (lastAssistantIndex >= 0) recoveryInput = recoveryInput.filter((_item, index) => index !== lastAssistantIndex);
			}
			const instructions = typeof basePayload?.instructions === "string" ? basePayload.instructions : ctx.getSystemPrompt();
			const tools = Array.isArray(basePayload?.tools) ? basePayload.tools : deps.getAllTools();
			const reservedTokens = approximateCompactionRequestTokens({ input: [], instructions, tools, includeTrigger: true });
			const input = latestRemoteCompactionSuffix(recoveryInput, model.contextWindow, reservedTokens);
			if (input.length === 0) throw contextOverflowRecoveryError(model);
			return input;
		}
		const currentBranch = deps.getBranch(ctx);
		return effectiveInputForBranch({
			branch: currentBranch,
			model,
			tools: deps.getAllTools(),
			allowCheckpointModelMismatch: true,
			excludeLastAssistantError,
		});
	};

	return {
		clear,
		recordFailedRequest,
		selectModel,
		recoverCurrentModel,
		prepareRequest,
		prepareCompaction,
	};
}

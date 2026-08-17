import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { compactionHash } from "./capabilities.ts";
import {
	effectiveInputForBranch,
	findNativeCheckpoint,
	isFailClosedCompactionError,
	fullInputForBranch,
	piContextInputForBranch,
	systemPromptInputForModel,
	isOpenAICodexModel,
	modelKey,
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
	withStatus: <T>(ctx: ExtensionContext, operation: () => Promise<T>) => Promise<T>;
	appendCheckpoint: (details: NativeCompactionDetails) => void;
	shouldAutoCompact?: (params: { ctx: ExtensionContext; model: Model<any>; input: ResponseItem[] }) => boolean;
};

type PendingTransition = {
	previousModel: Model<any>;
	targetModelKey: string;
};

function needsTransitionCompaction(previousModel: Model<any>, currentModel: Model<any>): boolean {
	const previousHash = compactionHash(previousModel);
	const currentHash = compactionHash(currentModel);
	return previousHash !== undefined && currentHash !== undefined && previousHash !== currentHash;
}

function shouldRetryWithCurrentModel(error: unknown): boolean {
	if (typeof error === "object" && error !== null && "retryWithCurrentModel" in error) {
		return (error as { retryWithCurrentModel?: unknown }).retryWithCurrentModel === true;
	}
	const message = error instanceof Error ? error.message : String(error);
	if (isFailClosedCompactionError(message) || /(?:auth|account|invalid compaction)/i.test(message)) return false;
	return /(?:\b(?:400|403|408|409|429|5\d\d)\b|invalid request|unexpected status|context window|context_length_exceeded|invalid_prompt|usage limit|server overloaded|internal server|retry limit)/i.test(message);
}

function conversationLeafId(branch: SessionEntry[]): string | undefined {
	return [...branch].reverse().find((entry) => entry.type !== "custom")?.id;
}

function textContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(textContent).join("");
	if (!isRecord(value)) return "";
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

function branchBeforeCurrentUser(branch: SessionEntry[], requestInput: ResponseItem[] | undefined): SessionEntry[] {
	const requestUser = requestInput?.findLast((item) => item.role === "user");
	const currentUserIndex = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user");
	const currentUser = currentUserIndex >= 0 ? branch[currentUserIndex] : undefined;
	if (!requestUser || !currentUser || currentUser.type !== "message") return branch;
	if (branch.slice(currentUserIndex + 1).some((entry) => entry.type === "message")) return branch;
	return textContent(currentUser.message.content) === textContent(requestUser.content)
		? branch.filter((_entry, index) => index !== currentUserIndex)
		: branch;
}

function checkpointPreservesCurrentUser(branch: SessionEntry[], requestInput: ResponseItem[] | undefined): boolean {
	const checkpoint = findNativeCheckpoint(branch);
	const requestUser = requestInput?.findLast((item) => item.role === "user");
	const preservedUser = checkpoint.status === "valid" ? checkpoint.checkpoint.details.preservedInput?.findLast((item) => item.role === "user") : undefined;
	return Boolean(requestUser && preservedUser && textContent(preservedUser.content) === textContent(requestUser.content));
}

function preserveCurrentUser(
	details: NativeCompactionDetails,
	branch: SessionEntry[],
	requestInput: ResponseItem[] | undefined,
	compactionInput?: ResponseItem[],
): NativeCompactionDetails {
	const requestUser = requestInput?.findLast((item) => item.role === "user");
	const currentUser = branch.findLast((entry) => entry.type === "message" && entry.message.role === "user");
	if (!requestUser || !currentUser || currentUser.type !== "message") return details;
	if (compactionInput?.some((item) => item.role === "user" && textContent(item.content) === textContent(requestUser.content))) return details;
	return textContent(currentUser.message.content) === textContent(requestUser.content)
		? { ...details, preservedInput: [structuredClone(requestUser)] }
		: details;
}

function sameItem(left: ResponseItem, right: ResponseItem): boolean {
	return sameValue(left, right);
}

function sameValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left)
			&& Array.isArray(right)
			&& left.length === right.length
			&& left.every((item, index) => sameValue(item, right[index]));
	}
	if (!isRecord(left) || !isRecord(right)) return false;
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	return leftKeys.length === rightKeys.length
		&& leftKeys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestTail(
	requestInput: ResponseItem[] | undefined,
	prefixes: ResponseItem[][],
	systemPromptInput: ResponseItem[],
): ResponseItem[] {
	if (!requestInput) return [];
	for (const prefix of prefixes.flatMap((value) => systemPromptInput.length > 0 ? [value, [...systemPromptInput, ...value]] : [value])) {
		if (requestInput.length < prefix.length) continue;
		if (prefix.every((item, index) => sameItem(item, requestInput[index]!))) {
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

export function createSessionCoordinator(deps: SessionCoordinatorDeps) {
	const pendingBySession = new Map<string, PendingTransition>();
	const transitionBySession = new Map<string, Promise<void>>();
	const automaticCompactionBySession = new Map<string, Promise<void>>();
	const failureBySession = new Map<string, { modelKey: string; message: string }>();
	let generation = 0;

	const clear = (): void => {
		generation++;
		pendingBySession.clear();
		transitionBySession.clear();
		automaticCompactionBySession.clear();
		failureBySession.clear();
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
	): Promise<void> => {
		for (let attempt = 0; attempt < 3; attempt++) {
			const branch = deps.getBranch(ctx);
			const leafId = conversationLeafId(branch);
			const compactionBranch = branchBeforeCurrentUser(branch, requestInput);
			const input = effectiveInputForBranch({
				branch: compactionBranch,
				model: previousModel,
				tools: deps.getAllTools(),
				allowCheckpointModelMismatch: true,
			});
			let native: Awaited<ReturnType<CheckpointFactory>>;
			try {
				native = await deps.withStatus(ctx, () => deps.createCheckpoint({
					ctx,
					model: previousModel,
					input,
					basePayload,
					signal: ctx.signal,
				}));
			} catch (firstError) {
				if (
					(modelKey(currentModel) === modelKey(previousModel) && compactionHash(currentModel) === compactionHash(previousModel))
					|| !shouldRetryWithCurrentModel(firstError)
				) throw firstError;
				try {
					native = await deps.withStatus(ctx, () => deps.createCheckpoint({
						ctx,
						model: currentModel,
						input: effectiveInputForBranch({
							branch: compactionBranch,
							model: currentModel,
							tools: deps.getAllTools(),
							allowCheckpointModelMismatch: true,
						}),
						basePayload,
						signal: ctx.signal,
					}));
				} catch {
					throw firstError;
				}
			}
			if (generation !== startGeneration || conversationLeafId(deps.getBranch(ctx)) !== leafId) continue;
			deps.appendCheckpoint({
				...preserveCurrentUser(native.details, branch, requestInput, input),
				modelKey: targetModelKey,
				compHash: compactionHash(currentModel),
			});
			pendingBySession.delete(sessionId);
			return;
		}
		throw new Error("The session changed while Codex model-transition compaction was running.");
	};

	const recoverCurrentModel = async (model: Model<any>, ctx: ExtensionContext, basePayload?: JsonObject, requestInput?: ResponseItem[]): Promise<void> => {
		if (!isOpenAICodexModel(model)) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const checkpoint = findNativeCheckpoint(deps.getBranch(ctx));
		if (checkpoint.status !== "valid") return;
		const pending = transitionBySession.get(sessionId);
		if (pending) {
			await pending.catch(() => undefined);
			return;
		}
		const previousModel = resolveModel(ctx, checkpoint.checkpoint.details.modelKey);
		const previousHash = checkpoint.checkpoint.details.compHash ?? (previousModel ? compactionHash(previousModel) : undefined);
		const currentHash = compactionHash(model);
		if (previousHash === undefined || currentHash === undefined || previousHash === currentHash) return;
		const startGeneration = generation;
		const transition = previousModel
			? runTransition(sessionId, ctx, previousModel, modelKey(model), model, basePayload, startGeneration, requestInput)
			: (async () => {
					const branch = deps.getBranch(ctx);
					const leafId = conversationLeafId(branch);
					const native = await deps.withStatus(ctx, () => deps.createCheckpoint({
						ctx,
						model,
						input: effectiveInputForBranch({
							branch: branchBeforeCurrentUser(branch, requestInput),
							model,
							tools: deps.getAllTools(),
							allowCheckpointModelMismatch: true,
						}),
						basePayload,
						signal: ctx.signal,
					}));
					if (generation !== startGeneration || conversationLeafId(deps.getBranch(ctx)) !== leafId) {
						throw new Error("The session changed while Codex model-transition compaction was running.");
					}
					deps.appendCheckpoint({
						...preserveCurrentUser(native.details, branch, requestInput),
						modelKey: modelKey(model),
						...(currentHash ? { compHash: currentHash } : {}),
					});
				})();
		transitionBySession.set(sessionId, transition);
		try {
			await transition;
		} catch (error) {
			if (generation === startGeneration) {
				failureBySession.set(sessionId, { modelKey: modelKey(model), message: error instanceof Error ? error.message : String(error) });
			}
			throw error;
		} finally {
			if (transitionBySession.get(sessionId) === transition) transitionBySession.delete(sessionId);
		}
	};

	const selectModel = async (event: ModelSelectLike, ctx: ExtensionContext): Promise<void> => {
		const sessionId = ctx.sessionManager.getSessionId();
		failureBySession.delete(sessionId);
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
		if (!needsTransitionCompaction(transitionPreviousModel, event.model)) {
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
		});
	};

	const prepareRequest = async (
		model: Model<any>,
		ctx: ExtensionContext,
		requestInput: ResponseItem[] | undefined,
		basePayload?: JsonObject,
		skipAutomaticCompaction = false,
	): Promise<ResponseItem[] | undefined> => {
		const sessionId = ctx.sessionManager.getSessionId();
		const activeTransition = transitionBySession.get(sessionId);
		if (activeTransition) {
			await activeTransition;
			return prepareRequest(model, ctx, requestInput, basePayload, false);
		}
		const branchBefore = deps.getBranch(ctx);
		let pending = pendingBySession.get(sessionId);
		const checkpoint = findNativeCheckpoint(branchBefore);
		if (
			pending
			&& checkpoint.status === "valid"
			&& checkpoint.checkpoint.details.strategy !== "token-budget"
			&& checkpoint.checkpoint.details.modelKey === modelKey(model)
		) {
			pendingBySession.delete(sessionId);
			pending = undefined;
		}
		const checkpointModelKey = checkpoint.status === "valid" ? checkpoint.checkpoint.details.modelKey : undefined;
		if (pending && pending.targetModelKey !== modelKey(model)) {
			throw new Error("The pending Codex model transition targets a different model.");
		}
		if (!requestInput && (pending || checkpoint.status !== "none")) {
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
			if (!pending && checkpoint.status === "none") return undefined;
			throw error;
		}

		const activeAutomaticCompaction = automaticCompactionBySession.get(sessionId);
		if (activeAutomaticCompaction) {
			await activeAutomaticCompaction;
			return prepareRequest(model, ctx, requestInput, basePayload, true);
		}
		if (pending && pending.targetModelKey === modelKey(model)) {
			const startGeneration = generation;
			const transition = runTransition(sessionId, ctx, pending.previousModel, pending.targetModelKey, model, basePayload, startGeneration, requestInput);
			transitionBySession.set(sessionId, transition);
			try {
				await transition;
			} catch (error) {
				if (generation === startGeneration) {
					failureBySession.set(sessionId, { modelKey: modelKey(model), message: error instanceof Error ? error.message : String(error) });
				}
				throw error;
			} finally {
				if (transitionBySession.get(sessionId) === transition) transitionBySession.delete(sessionId);
			}
			skipAutomaticCompaction = false;
		}

		await recoverCurrentModel(model, ctx, basePayload, requestInput);
		const recoveredCheckpoint = findNativeCheckpoint(deps.getBranch(ctx));
		if (recoveredCheckpoint.status === "valid" && recoveredCheckpoint.checkpoint.details.strategy !== "token-budget") {
			const checkpointDetails = recoveredCheckpoint.checkpoint.details;
			if (checkpointDetails.modelKey !== modelKey(model)) {
				const checkpointModel = resolveModel(ctx, checkpointDetails.modelKey);
				const checkpointHash = checkpointDetails.compHash ?? (checkpointModel ? compactionHash(checkpointModel) : undefined);
				const currentHash = compactionHash(model);
				if (checkpointHash === undefined || currentHash === undefined || checkpointHash !== currentHash) {
					throw new Error("The latest Codex compaction checkpoint requires model-transition compaction first.");
				}
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
				if (deps.shouldAutoCompact?.({ ctx, model, input: currentHistory })) {
					const startGeneration = generation;
					const leafId = conversationLeafId(branch);
					const automaticCompaction = deps.withStatus(ctx, () => deps.createCheckpoint({
						ctx,
						model,
						input: currentHistory,
						basePayload,
						signal: ctx.signal,
					})).then((native) => {
						if (generation !== startGeneration || conversationLeafId(deps.getBranch(ctx)) !== leafId) {
							throw new Error("The session changed while Codex automatic compaction was running.");
						}
						deps.appendCheckpoint(preserveCurrentUser(native.details, branch, requestInput, currentHistory));
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
		if (currentCheckpoint.status === "none") return undefined;
		if (checkpointPreservesCurrentUser(branch, requestInput)) {
			const requestUserIndex = tail.findLastIndex((item) => item.role === "user");
			if (requestUserIndex >= 0) tail = tail.filter((_item, index) => index !== requestUserIndex);
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

	return {
		clear,
		selectModel,
		recoverCurrentModel,
		prepareRequest,
		transitionFailure: (sessionId: string, model: Model<any>) => {
			const failure = failureBySession.get(sessionId);
			return failure?.modelKey === modelKey(model) ? failure.message : undefined;
		},
	};
}

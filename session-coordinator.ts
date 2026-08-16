import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { compactionHash } from "./capabilities.ts";
import {
	effectiveInputForBranch,
	findNativeCheckpoint,
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

function conversationLeafId(branch: SessionEntry[]): string | undefined {
	return [...branch].reverse().find((entry) => entry.type !== "custom")?.id;
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
	const failureBySession = new Map<string, { modelKey: string; message: string }>();
	const scheduledSessions = new Set<string>();
	let generation = 0;

	const clear = (): void => {
		generation++;
		pendingBySession.clear();
		transitionBySession.clear();
		failureBySession.clear();
		scheduledSessions.clear();
	};

	const runTransition = async (
		sessionId: string,
		ctx: ExtensionContext,
		previousModel: Model<any>,
		targetModelKey: string,
		currentModel: Model<any>,
		basePayload: JsonObject | undefined,
		startGeneration: number,
	): Promise<void> => {
		for (let attempt = 0; attempt < 3; attempt++) {
			const branch = deps.getBranch(ctx);
			const leafId = conversationLeafId(branch);
			const input = effectiveInputForBranch({
				branch,
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
				}));
			} catch (firstError) {
				if (modelKey(currentModel) === modelKey(previousModel)) throw firstError;
				try {
					native = await deps.withStatus(ctx, () => deps.createCheckpoint({
						ctx,
						model: currentModel,
						input,
						basePayload,
					}));
				} catch (fallbackError) {
					throw new Error(`${firstError instanceof Error ? firstError.message : String(firstError)}; current-model fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
				}
			}
			if (generation !== startGeneration || conversationLeafId(deps.getBranch(ctx)) !== leafId) continue;
			deps.appendCheckpoint({
				...native.details,
				modelKey: targetModelKey,
				compHash: compactionHash(currentModel),
			});
			pendingBySession.delete(sessionId);
			return;
		}
		throw new Error("The session changed while Codex model-transition compaction was running.");
	};

	const recoverCurrentModel = async (model: Model<any>, ctx: ExtensionContext, basePayload?: JsonObject): Promise<void> => {
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
			? runTransition(sessionId, ctx, previousModel, modelKey(model), model, basePayload, startGeneration)
			: (async () => {
					const branch = deps.getBranch(ctx);
					const leafId = conversationLeafId(branch);
					const native = await deps.withStatus(ctx, () => deps.createCheckpoint({
						ctx,
						model,
						input: effectiveInputForBranch({
							branch,
							model,
							tools: deps.getAllTools(),
							allowCheckpointModelMismatch: true,
						}),
						basePayload,
					}));
					if (generation !== startGeneration || conversationLeafId(deps.getBranch(ctx)) !== leafId) {
						throw new Error("The session changed while Codex model-transition compaction was running.");
					}
					deps.appendCheckpoint({
						...native.details,
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
		if (pending && modelKey(event.model) === modelKey(pending.previousModel)) {
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
	): Promise<ResponseItem[] | undefined> => {
		const sessionId = ctx.sessionManager.getSessionId();
		const activeTransition = transitionBySession.get(sessionId);
		if (activeTransition) {
			await activeTransition;
			return prepareRequest(model, ctx, requestInput, basePayload);
		}
		const branchBefore = deps.getBranch(ctx);
		const pending = pendingBySession.get(sessionId);
		const checkpoint = findNativeCheckpoint(branchBefore);
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
		const historyInput = effectiveInputForBranch({
			branch: branchBefore,
			model: historyModel,
			tools,
			allowCheckpointModelMismatch: true,
		});
		const rawHistoryInput = fullInputForBranch({ branch: branchBefore, model: historyModel, tools });
		const piContextInput = piContextInputForBranch({ branch: branchBefore, model: historyModel, tools });
		const currentHistoryInput = effectiveInputForBranch({
			branch: branchBefore,
			model,
			tools,
			allowCheckpointModelMismatch: true,
		});
		const currentRawHistoryInput = fullInputForBranch({ branch: branchBefore, model, tools });
		const currentPiContextInput = piContextInputForBranch({ branch: branchBefore, model, tools });
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

		let transitioned = false;
		if (pending && pending.targetModelKey === modelKey(model)) {
			const startGeneration = generation;
			const transition = runTransition(sessionId, ctx, pending.previousModel, pending.targetModelKey, model, basePayload, startGeneration);
			transitionBySession.set(sessionId, transition);
			try {
				await transition;
				transitioned = true;
			} catch (error) {
				if (generation === startGeneration) {
					failureBySession.set(sessionId, { modelKey: modelKey(model), message: error instanceof Error ? error.message : String(error) });
				}
				throw error;
			} finally {
				if (transitionBySession.get(sessionId) === transition) transitionBySession.delete(sessionId);
			}
		}

		await recoverCurrentModel(model, ctx, basePayload);
		let branch = deps.getBranch(ctx);
		if (!transitioned) {
			const currentHistory = effectiveInputForBranch({
				branch,
				model,
				tools: deps.getAllTools(),
				allowCheckpointModelMismatch: true,
			});
			if (deps.shouldAutoCompact?.({ ctx, model, input: currentHistory })) {
				const startGeneration = generation;
				const leafId = conversationLeafId(branch);
				const native = await deps.withStatus(ctx, () => deps.createCheckpoint({
					ctx,
					model,
					input: currentHistory,
					basePayload,
				}));
				if (generation !== startGeneration || conversationLeafId(deps.getBranch(ctx)) !== leafId) {
					throw new Error("The session changed while Codex automatic compaction was running.");
				}
				deps.appendCheckpoint(native.details);
				branch = deps.getBranch(ctx);
			}
		}
		const currentCheckpoint = findNativeCheckpoint(branch);
		if (currentCheckpoint.status === "none") return undefined;
		return [
			...effectiveInputForBranch({
				branch,
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
		schedule: (sessionId: string): boolean => {
			if (scheduledSessions.has(sessionId)) return false;
			scheduledSessions.add(sessionId);
			return true;
		},
		consumeScheduled: (sessionId: string): boolean => {
			if (!scheduledSessions.delete(sessionId)) return false;
			return true;
		},
	};
}

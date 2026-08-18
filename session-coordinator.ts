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

function conversationLeafId(branch: SessionEntry[]): string | undefined {
	return [...branch].reverse().find((entry) => entry.type !== "custom")?.id;
}

function hasBranchTailAfterCheckpoint(branch: SessionEntry[]): boolean {
	const checkpoint = findNativeCheckpoint(branch);
	return checkpoint.status !== "valid"
		|| branch.slice(checkpoint.checkpoint.entryIndex + 1).some((entry) => entry.type === "message");
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
): NativeCompactionDetails {
	const requestUser = requestInput?.findLast((item) => item.role === "user");
	const currentUser = branch.findLast((entry) => entry.type === "message" && entry.message.role === "user");
	if (!requestUser || !currentUser || currentUser.type !== "message") return details;
	if (details.replacementHistory.some((item) => item.role === "user" && textContent(item.content) === textContent(requestUser.content))) return details;
	return textContent(currentUser.message.content) === textContent(requestUser.content)
		? { ...details, preservedInput: [structuredClone(requestUser)] }
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

function preserveRequestUser(details: NativeCompactionDetails, requestInput: ResponseItem[]): NativeCompactionDetails {
	const requestUser = requestInput.findLast((item) => item.role === "user");
	if (!requestUser || details.replacementHistory.some((item) => sameItem(item, requestUser))) return details;
	return { ...details, preservedInput: [structuredClone(requestUser)] };
}

function sameItem(left: ResponseItem, right: ResponseItem): boolean {
	return sameValue(left, right);
}

function ensureNotAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new Error("Compaction aborted.");
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
	const candidates = prefixes.flatMap((value) => systemPromptInput.length > 0 ? [value, [...systemPromptInput, ...value]] : [value]);
	for (const prefix of candidates) {
		if (requestInput.length < prefix.length) continue;
		if (prefix.every((item, index) => sameItem(item, requestInput[index]!))) {
			return requestInput.slice(prefix.length);
		}
	}
	throw new Error("The Codex request changed before model-transition compaction completed.");
}

// ponytail: O(history × request) only on the legacy migration fallback; index item IDs if fork transforms make this hot.
function unmatchedRequestItems(
	requestInput: ResponseItem[],
	histories: ResponseItem[][],
	preservedItems: ResponseItem[] = [],
): ResponseItem[] {
	let bestMatches: number[] = [];
	for (const history of histories) {
		let requestIndex = 0;
		const matches: number[] = [];
		for (const historyItem of history) {
			const nextIndex = requestInput.findIndex((item, index) => index >= requestIndex && sameItem(item, historyItem));
			if (nextIndex < 0) continue;
			requestIndex = nextIndex + 1;
			matches.push(nextIndex);
		}
		const lastMatch = matches.at(-1) ?? -1;
		const bestLastMatch = bestMatches.at(-1) ?? -1;
		if (matches.length > bestMatches.length || (matches.length === bestMatches.length && lastMatch > bestLastMatch)) {
			bestMatches = matches;
		}
	}
	const matchedIndexes = new Set(bestMatches);
	const preservedIndexes = new Set<number>();
	for (const preservedItem of preservedItems) {
		const preservedIndex = requestInput.findLastIndex((item, index) => !preservedIndexes.has(index) && sameItem(item, preservedItem));
		if (preservedIndex >= 0) {
			preservedIndexes.add(preservedIndex);
			matchedIndexes.delete(preservedIndex);
		}
	}
	const unmatched = requestInput.filter((_item, index) => !matchedIndexes.has(index));
	return [
		...unmatched,
		...preservedItems.filter((item) => !requestInput.some((requestItem) => sameItem(requestItem, item))),
	];
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
	if (selectedIndex < 0) return undefined;
	if (branch.slice(selectedIndex + 1).some((entry) => entry.type === "message" && entry.message.role === "assistant")) return undefined;
	const previousAssistant = branch.slice(0, selectedIndex).findLast((entry) =>
		entry.type === "message"
			&& entry.message.role === "assistant"
			&& typeof entry.message.provider === "string"
			&& typeof entry.message.api === "string"
			&& typeof entry.message.model === "string",
	);
	if (!previousAssistant || previousAssistant.type !== "message") return undefined;
	const previousModel = resolveModel(ctx, modelKey({
		provider: previousAssistant.message.provider!,
		api: previousAssistant.message.api!,
		id: previousAssistant.message.model!,
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
	const pendingBySession = new Map<string, PendingTransition>();
	const transitionBySession = new Map<string, Promise<void>>();
	const automaticCompactionBySession = new Map<string, Promise<void>>();
	const legacyMigrationBySession = new Map<string, Promise<NativeCompactionDetails>>();
	let generation = 0;

	const clear = (): void => {
		generation++;
		pendingBySession.clear();
		transitionBySession.clear();
		automaticCompactionBySession.clear();
		legacyMigrationBySession.clear();
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
				native = await deps.withStatus(ctx, () => deps.createCheckpoint({
					ctx,
					model: previousModel,
					input,
					basePayload,
					signal: operationSignal,
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
							excludeLastAssistantError,
						}),
						basePayload,
						signal: operationSignal,
					}));
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

	const migrateLegacyCheckpoint = async (
		sessionId: string,
		ctx: ExtensionContext,
		model: Model<any>,
		legacy: Extract<ReturnType<typeof findNativeCheckpoint>, { status: "legacy" }>,
		basePayload: JsonObject | undefined,
		requestInput: ResponseItem[],
		startGeneration: number,
		signal?: AbortSignal,
	): Promise<NativeCompactionDetails> => {
		const operationSignal = signal ?? ctx.signal;
		const branch = deps.getBranch(ctx);
		const leafId = conversationLeafId(branch);
		const compactionBranch = branchBeforeCurrentUser(branch, requestInput);
		const previousModel = resolveModel(ctx, legacy.checkpoint.details.modelKey);
		const historyModel = previousModel && isOpenAICodexModel(previousModel) ? previousModel : model;
		const createFor = (selectedModel: Model<any>) => deps.withStatus(ctx, () => deps.createCheckpoint({
			ctx,
			model: selectedModel,
			input: fullInputForBranch({ branch: compactionBranch, model: selectedModel, tools: deps.getAllTools() }),
			basePayload,
			signal: operationSignal,
		}));
		let native: Awaited<ReturnType<CheckpointFactory>>;
		try {
			native = await createFor(historyModel);
		} catch (firstError) {
			if (modelKey(historyModel) === modelKey(model) || !shouldRetryWithCurrentModel(firstError)) throw firstError;
			try {
				native = await createFor(model);
			} catch {
				throw firstError;
			}
		}
		ensureNotAborted(operationSignal);
		if (generation !== startGeneration || conversationLeafId(deps.getBranch(ctx)) !== leafId) {
			throw new Error("The session changed while legacy Codex compaction migration was running.");
		}
		const migrated = rebindCheckpoint(
			preserveCurrentUser(native.details, branch, requestInput),
			modelKey(model),
			compactionHash(model),
		);
		deps.appendCheckpoint(migrated);
		pendingBySession.delete(sessionId);
		return migrated;
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
			if (deps.shouldAutoCompact?.({ ctx, model, input }) !== true) return;
		}
		const startGeneration = generation;
		const transition = previousModel
			? runTransition(sessionId, ctx, previousModel, modelKey(model), model, basePayload, startGeneration, requestInput, excludeLastAssistantError, operationSignal)
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
							excludeLastAssistantError,
						}),
						basePayload,
						signal: operationSignal,
					}));
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
	): Promise<ResponseItem[] | undefined> => {
		const sessionId = ctx.sessionManager.getSessionId();
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
		const checkpointModelKey = checkpoint.status === "valid" || checkpoint.status === "legacy"
			? checkpoint.checkpoint.details.modelKey
			: undefined;
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
		const legacyCheckpoint = checkpoint.status === "legacy";
		const historyInput = legacyCheckpoint
			? fullInputForBranch({ branch: historyBranch, model: historyModel, tools })
			: effectiveInputForBranch({
					branch: historyBranch,
					model: historyModel,
					tools,
					allowCheckpointModelMismatch: true,
				});
		const rawHistoryInput = fullInputForBranch({ branch: historyBranch, model: historyModel, tools });
		const piContextInput = legacyCheckpoint
			? rawHistoryInput
			: piContextInputForBranch({ branch: historyBranch, model: historyModel, tools });
		const currentHistoryInput = legacyCheckpoint
			? fullInputForBranch({ branch: historyBranch, model, tools })
			: effectiveInputForBranch({
					branch: historyBranch,
					model,
					tools,
					allowCheckpointModelMismatch: true,
				});
		const currentRawHistoryInput = fullInputForBranch({ branch: historyBranch, model, tools });
		const currentPiContextInput = legacyCheckpoint
			? currentRawHistoryInput
			: piContextInputForBranch({ branch: historyBranch, model, tools });
		const systemPromptInput = systemPromptInputForModel(model, ctx.getSystemPrompt());
		const runLegacyMigration = async (): Promise<NativeCompactionDetails> => {
			if (checkpoint.status !== "legacy" || !requestInput) {
				throw new Error("The Codex request input is unavailable while migrating legacy compaction state.");
			}
			const activeMigration = legacyMigrationBySession.get(sessionId);
			if (activeMigration) return activeMigration;
			const startGeneration = generation;
			const migration = migrateLegacyCheckpoint(sessionId, ctx, model, checkpoint, basePayload, requestInput, startGeneration);
			legacyMigrationBySession.set(sessionId, migration);
			try {
				return await migration;
			} finally {
				if (legacyMigrationBySession.get(sessionId) === migration) legacyMigrationBySession.delete(sessionId);
			}
		};
		let tail: ResponseItem[];
		try {
			tail = requestTail(
				requestInput,
				[historyInput, piContextInput, rawHistoryInput, currentHistoryInput, currentPiContextInput, currentRawHistoryInput],
				systemPromptInput,
			);
		} catch (error) {
			if (checkpoint.status === "legacy") {
				const migrated = await runLegacyMigration();
				const preserved = migrated.preservedInput ?? [];
				const migratedTail = unmatchedRequestItems(requestInput!, [
					rawHistoryInput,
					currentRawHistoryInput,
					historyInput,
					currentHistoryInput,
				], preserved);
				return [...migrated.replacementHistory, ...migratedTail];
			}
			if (!pending && checkpoint.status === "none") return undefined;
			const createCheckpointFor = (selectedModel: Model<any>) => deps.withStatus(ctx, () => deps.createCheckpoint({
				ctx,
				model: selectedModel,
				input: requestInput!,
				basePayload,
				signal: ctx.signal,
			}));
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

		if (checkpoint.status === "legacy") {
			await runLegacyMigration();
			const migratedBranch = deps.getBranch(ctx);
			const migratedCheckpoint = findNativeCheckpoint(migratedBranch);
			if (migratedCheckpoint.status !== "valid") {
				throw new Error("Legacy Codex compaction migration did not create a valid checkpoint.");
			}
			const migratedTail = unmatchedRequestItems(requestInput!, [
				rawHistoryInput,
				currentRawHistoryInput,
				historyInput,
				currentHistoryInput,
			], migratedCheckpoint.checkpoint.details.preservedInput ?? []);
			return [...migratedCheckpoint.checkpoint.details.replacementHistory, ...migratedTail];
		}

		const activeAutomaticCompaction = automaticCompactionBySession.get(sessionId);
		if (activeAutomaticCompaction) {
			await activeAutomaticCompaction;
			return prepareRequest(model, ctx, requestInput, basePayload, true);
		}
		if (pending && pending.targetModelKey === modelKey(model)) {
			const shouldRun = pending.reason === "hash"
				|| deps.shouldAutoCompact?.({ ctx, model, input: currentHistoryInput }) === true;
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
					const automaticCompaction = deps.withStatus(ctx, () => deps.createCheckpoint({
						ctx,
						model,
						input: currentHistory,
						basePayload,
						signal: ctx.signal,
					})).then((native) => {
						ensureNotAborted(ctx.signal);
						if (generation !== startGeneration || conversationLeafId(deps.getBranch(ctx)) !== leafId) {
							throw new Error("The session changed while Codex automatic compaction was running.");
						}
						deps.appendCheckpoint(preserveCurrentUser(native.details, branch, requestInput));
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

	const prepareCompaction = async (
		model: Model<any>,
		ctx: ExtensionContext,
		requestInput?: ResponseItem[],
		basePayload?: JsonObject,
		excludeLastAssistantError = false,
		signal?: AbortSignal,
	): Promise<ResponseItem[]> => {
		if (!isOpenAICodexModel(model)) return [];
		const operationSignal = signal ?? ctx.signal;
		const sessionId = ctx.sessionManager.getSessionId();
		const activeTransition = transitionBySession.get(sessionId);
		if (activeTransition) await activeTransition;
		const branch = deps.getBranch(ctx);
		let pending = pendingBySession.get(sessionId);
		const checkpoint = findNativeCheckpoint(branch);
		if (!pending && checkpoint.status === "none") {
			pending = pendingTransitionFromBranch(branch, model, ctx);
			if (pending) pendingBySession.set(sessionId, pending);
		}
		if (pending && pending.targetModelKey !== modelKey(model)) {
			throw new Error("The pending Codex model transition targets a different model.");
		}
		if (pending) {
			const startGeneration = generation;
			const transition = runTransition(
				sessionId,
				ctx,
				pending.previousModel,
				pending.targetModelKey,
				model,
				basePayload,
				startGeneration,
				requestInput,
				excludeLastAssistantError,
				operationSignal,
			);
			transitionBySession.set(sessionId, transition);
			try {
				await transition;
			} finally {
				if (transitionBySession.get(sessionId) === transition) transitionBySession.delete(sessionId);
			}
		}
		await recoverCurrentModel(model, ctx, basePayload, requestInput, true, excludeLastAssistantError, operationSignal);
		ensureNotAborted(operationSignal);
		const currentBranch = deps.getBranch(ctx);
		return effectiveInputForBranch({
			branch: branchBeforeCurrentUser(currentBranch, requestInput),
			model,
			tools: deps.getAllTools(),
			allowCheckpointModelMismatch: true,
			excludeLastAssistantError,
		});
	};

	return {
		clear,
		selectModel,
		recoverCurrentModel,
		prepareRequest,
		prepareCompaction,
	};
}

import { describe, expect, test } from "bun:test";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { createSessionCoordinator } from "./session-coordinator.ts";
import { modelKey, NATIVE_COMPACTION_KIND, type NativeCompactionDetails, type ResponseItem } from "./native-compaction.ts";

function model(provider: string, id: string, compHash: string | undefined = `test-${id}`): Model<any> {
	return { provider, api: "openai-codex-responses", id, reasoning: true, ...(compHash !== undefined ? { compHash } : {}) } as Model<any>;
}

function modelWithoutHash(provider: string, id: string): Model<any> {
	return { ...model(provider, id), compHash: undefined } as Model<any>;
}

function context(models: Model<any>[] = [], systemPrompt = "instructions"): ExtensionContext {
	return {
		getSystemPrompt: () => systemPrompt,
		sessionManager: {
			getSessionId: () => "session",
			getBranch: () => [],
		},
		modelRegistry: {
			find: (provider: string, id: string) => models.find((candidate) => candidate.provider === provider && candidate.id === id),
		},
	} as unknown as ExtensionContext;
}

function details(key: string, encrypted = "opaque"): NativeCompactionDetails {
	return {
		kind: NATIVE_COMPACTION_KIND,
		version: 1,
		strategy: "v2",
		modelKey: key,
		replacementHistory: [{ type: "compaction", encrypted_content: encrypted }],
	};
}

function checkpointEntry(data: NativeCompactionDetails): SessionEntry {
	return {
		id: "checkpoint",
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "custom",
		customType: NATIVE_COMPACTION_KIND,
		data,
	} as unknown as SessionEntry;
}

function nativeCompactionEntry(data: NativeCompactionDetails, firstKeptEntryId: string): SessionEntry {
	return {
		id: "checkpoint",
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "compaction",
		summary: "OpenAI Codex native compaction checkpoint.",
		firstKeptEntryId,
		details: data,
	} as unknown as SessionEntry;
}

function createCoordinator(
	branch: SessionEntry[] = [],
	createCheckpoint?: (model: Model<any>, basePayload?: Record<string, unknown>) => Promise<NativeCompactionDetails>,
	appendCheckpoint?: (details: NativeCompactionDetails) => void,
	shouldAutoCompact?: (input: ResponseItem[]) => boolean,
) {
	return createSessionCoordinator({
		getBranch: () => branch,
		getAllTools: () => [],
		createCheckpoint: async ({ model: selectedModel, basePayload }) => ({
			details: createCheckpoint ? await createCheckpoint(selectedModel, basePayload) : details(modelKey(selectedModel)),
		}),
		withStatus: async (_ctx, operation) => operation(),
		appendCheckpoint: (value) => {
			branch.push(checkpointEntry(value));
			appendCheckpoint?.(value);
		},
		shouldAutoCompact: shouldAutoCompact ? ({ input }) => shouldAutoCompact(input) : undefined,
	});
}

const userInput = (text: string): ResponseItem => ({
	role: "user",
	content: [{ type: "input_text", text }],
});

describe("Codex session coordinator", () => {
	test("schedules one compaction until it is consumed", () => {
		const coordinator = createCoordinator();
		expect(coordinator.schedule("session")).toBe(true);
		expect(coordinator.schedule("session")).toBe(false);
		expect(coordinator.consumeScheduled("session")).toBe(true);
		expect(coordinator.consumeScheduled("session")).toBe(false);
	});

	test("clear removes pending lifecycle state", () => {
		const coordinator = createCoordinator();
		coordinator.schedule("session");
		coordinator.clear();
		expect(coordinator.consumeScheduled("session")).toBe(false);
		expect(coordinator.schedule("session")).toBe(true);
	});

	test("does not compact when the model is selected", async () => {
		let calls = 0;
		const coordinator = createCoordinator([], async () => {
			calls++;
			return details("source");
		});
		const oldModel = model("openai-codex", "old", "shared");
		await coordinator.selectModel({ model: model("openai-codex", "new", "shared"), previousModel: oldModel }, context());
		expect(calls).toBe(0);
	});

	test("passes through an ordinary request when Pi sends a changed input shape", async () => {
		const currentModel = model("openai-codex", "current");
		const branch = [{
			id: "history",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "history" }] },
		} as unknown as SessionEntry];
		let compactions = 0;
		const coordinator = createCoordinator(branch, async () => {
			compactions++;
			return details(modelKey(currentModel));
		});

		await expect(coordinator.prepareRequest(currentModel, context(), [userInput("new")])).resolves.toBeUndefined();
		expect(compactions).toBe(0);
	});

	test("blocks a request for the wrong model while a transition is pending", async () => {
		const coordinator = createCoordinator();
		const previousModel = model("openai-codex", "previous");
		const targetModel = model("openai-codex", "target");
		await coordinator.selectModel({ model: targetModel, previousModel }, context());

		await expect(coordinator.prepareRequest(previousModel, context(), [userInput("hello")])).rejects.toThrow(
			"pending Codex model transition targets a different model",
		);
	});

	test("requires provider input when replaying a native checkpoint", async () => {
		const currentModel = model("openai-codex", "current");
		const coordinator = createCoordinator([checkpointEntry(details(modelKey(currentModel)))]);

		await expect(coordinator.prepareRequest(currentModel, context(), undefined)).rejects.toThrow(
			"Codex request input is unavailable while replaying compaction state",
		);
	});

	test("waits for an active transition instead of passing through", async () => {
		let signalStarted!: () => void;
		let release!: (value: NativeCompactionDetails) => void;
		const started = new Promise<void>((resolve) => { signalStarted = resolve; });
		const blocked = new Promise<NativeCompactionDetails>((resolve) => { release = resolve; });
		const previousModel = model("openai-codex", "previous");
		const targetModel = model("openai-codex", "target");
		const compacted = details(modelKey(targetModel));
		const coordinator = createCoordinator([], async () => {
			signalStarted();
			return blocked;
		});
		await coordinator.selectModel({ model: targetModel, previousModel }, context());
		const first = coordinator.prepareRequest(targetModel, context(), [userInput("hello")]);
		await started;
		await coordinator.selectModel({ model: model("anthropic", "other"), previousModel: targetModel }, context());
		const secondInput = [...compacted.replacementHistory, userInput("hello")];
		let secondFinished = false;
		const second = coordinator.prepareRequest(targetModel, context(), secondInput).then((input) => {
			secondFinished = true;
			return input;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(secondFinished).toBe(false);
		release(compacted);
		expect(await first).toEqual(secondInput);
		expect(await second).toEqual(secondInput);
		expect(secondFinished).toBe(true);
	});

	test("does not transition when either model hash is unavailable", async () => {
		let calls = 0;
		const coordinator = createCoordinator([], async () => {
			calls++;
			return details("unexpected");
		});
		const previous = modelWithoutHash("openai-codex", "previous");
		const current = model("openai-codex", "current", "hash-b");
		await coordinator.selectModel({ model: current, previousModel: previous }, context());
		await coordinator.prepareRequest(current, context(), [userInput("hello")]);
		expect(calls).toBe(0);
	});

	test("compacts when a thinking-level change exposes a different compaction hash", async () => {
		let calls = 0;
		const coordinator = createCoordinator([], async () => {
			calls++;
			return details("same-model");
		});
		const previous = model("openai-codex", "same", "hash-a");
		const current = model("openai-codex", "same", "hash-b");
		await coordinator.selectModel({ model: current, previousModel: previous }, context());
		await coordinator.prepareRequest(current, context(), [userInput("hello")]);
		expect(calls).toBe(1);
	});

	test("accepts Pi's system prompt before the request history", async () => {
		const currentModel = model("openai-codex", "current");
		const branch = [checkpointEntry(details(modelKey(currentModel)))];
		const coordinator = createCoordinator(branch);
		const input = await coordinator.prepareRequest(currentModel, context([], "system instructions"), [
			{ role: "developer", content: "system instructions" },
			...details(modelKey(currentModel)).replacementHistory,
			userInput("new"),
		]);
		expect(input).toEqual([...details(modelKey(currentModel)).replacementHistory, userInput("new")]);
	});

	test("matches provider items without depending on object key order", async () => {
		const currentModel = model("openai-codex", "current");
		const assistantEntry = {
			id: "assistant",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: {
				role: "assistant",
				provider: currentModel.provider,
				api: currentModel.api,
				model: currentModel.id,
				content: [{ type: "toolCall", id: "call|fc_item", name: "bash", arguments: { command: "echo" } }],
			},
		} as unknown as SessionEntry;
		const branch = [assistantEntry, checkpointEntry(details(modelKey(currentModel)))];
		const coordinator = createCoordinator(branch);
		const input = await coordinator.prepareRequest(currentModel, context(), [
			{ type: "function_call", id: "fc_item", call_id: "call", name: "bash", arguments: JSON.stringify({ command: "echo" }) },
			{ type: "function_call_output", call_id: "call", output: "No result provided" },
			userInput("new"),
		]);
		expect(input).toEqual([...details(modelKey(currentModel)).replacementHistory, userInput("new")]);
	});

	test("matches cross-model tool history after target-model normalization", async () => {
		const previousModel = model("openai-codex", "previous", "hash-a");
		const currentModel = model("openai-codex", "current", "hash-b");
		const assistantEntry = {
			id: "assistant",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: {
				role: "assistant",
				provider: previousModel.provider,
				api: previousModel.api,
				model: previousModel.id,
				content: [{ type: "toolCall", id: "call|fc_old", name: "bash", arguments: { command: "echo" } }],
			},
		} as unknown as SessionEntry;
		const branch = [assistantEntry];
		const coordinator = createCoordinator(branch);
		await coordinator.selectModel({ model: currentModel, previousModel }, context());
		const input = await coordinator.prepareRequest(currentModel, context(), [
			{ type: "function_call", id: undefined, call_id: "call", name: "bash", arguments: JSON.stringify({ command: "echo" }) },
			{ type: "function_call_output", call_id: "call", output: "No result provided" },
			userInput("new"),
		]);
		expect(input?.at(-1)).toEqual(userInput("new"));
	});

	test("matches cross-model visible thinking after signature removal", async () => {
		const previousModel = model("openai-codex", "previous", "hash-a");
		const currentModel = model("openai-codex", "current", "hash-b");
		const assistantEntry = {
			id: "assistant-thinking",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: {
				role: "assistant",
				provider: previousModel.provider,
				api: previousModel.api,
				model: previousModel.id,
				content: [{
					type: "thinking",
					thinking: "plan",
					thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_old", summary: [] }),
				}],
			},
		} as unknown as SessionEntry;
		const coordinator = createCoordinator([assistantEntry]);
		await coordinator.selectModel({ model: currentModel, previousModel }, context());
		const input = await coordinator.prepareRequest(currentModel, context(), [
			{ type: "message", role: "assistant", id: "msg_pi_0", status: "completed", phase: undefined, content: [{ type: "output_text", text: "plan", annotations: [] }] },
			userInput("new"),
		]);
		expect(input?.at(-1)).toEqual(userInput("new"));
	});

	test("normalizes foreign cross-model tool IDs like Pi", async () => {
		const previousModel = model("anthropic", "previous", "hash-a");
		const currentModel = model("openai-codex", "current", "hash-b");
		const branch = [{
			id: "foreign-assistant",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: {
				role: "assistant",
				provider: previousModel.provider,
				api: previousModel.api,
				model: previousModel.id,
				content: [{ type: "toolCall", id: "call|foreign_item", name: "bash", arguments: {} }],
			},
		} as unknown as SessionEntry];
		const coordinator = createCoordinator(branch);
		await coordinator.selectModel({ model: currentModel, previousModel: model("openai-codex", "previous", "hash-a") }, context());
		const input = await coordinator.prepareRequest(currentModel, context(), [
			{ type: "function_call", id: "fc_iso4ur1iqd9fs", call_id: "call", name: "bash", arguments: "{}" },
			{ type: "function_call_output", call_id: "call", output: "No result provided" },
			userInput("new"),
		]);
		expect(input?.at(-1)).toEqual(userInput("new"));
	});

	test("drops redacted thinking across models", async () => {
		const previousModel = model("openai-codex", "previous", "hash-a");
		const currentModel = model("openai-codex", "current", "hash-b");
		const branch = [{
			id: "redacted-assistant",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: {
				role: "assistant",
				provider: previousModel.provider,
				api: previousModel.api,
				model: previousModel.id,
				content: [{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true, thinkingSignature: "opaque" }],
			},
		} as unknown as SessionEntry, {
			id: "visible-assistant",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: {
				role: "assistant",
				provider: previousModel.provider,
				api: previousModel.api,
				model: previousModel.id,
				content: [{ type: "text", text: "visible" }],
			},
		} as unknown as SessionEntry];
		const coordinator = createCoordinator(branch);
		await coordinator.selectModel({ model: currentModel, previousModel }, context());
		const input = await coordinator.prepareRequest(currentModel, context(), [
			{ type: "message", role: "assistant", id: "msg_pi_0", status: "completed", phase: undefined, content: [{ type: "output_text", text: "visible", annotations: [] }] },
			userInput("new"),
		]);
		expect(input?.at(-1)).toEqual(userInput("new"));
	});

	test("compacts on the first request after a model selection", async () => {
		let compactedWith: string | undefined;
		let appended: NativeCompactionDetails | undefined;
		const branch: SessionEntry[] = [];
		const coordinator = createCoordinator(branch, async (selectedModel) => {
			compactedWith = modelKey(selectedModel);
			return details(modelKey(selectedModel));
		}, (value) => { appended = value; });
		const oldModel = model("openai-codex", "old");
		const newModel = model("openai-codex", "new");
		await coordinator.selectModel({ model: newModel, previousModel: oldModel }, context());
		const input = await coordinator.prepareRequest(newModel, context(), [userInput("hello")]);
		expect(compactedWith).toBe(modelKey(oldModel));
		expect(appended?.modelKey).toBe(modelKey(newModel));
		expect(input).toEqual([{ type: "compaction", encrypted_content: "opaque" }, userInput("hello")]);
	});

	test("passes the current request parameters to transition compaction", async () => {
		let receivedPayload: Record<string, unknown> | undefined;
		const coordinator = createCoordinator([], async (_selectedModel, basePayload) => {
			receivedPayload = basePayload;
			return details("new");
		});
		const oldModel = model("openai-codex", "old");
		const newModel = model("openai-codex", "new");
		await coordinator.selectModel({ model: newModel, previousModel: oldModel }, context());
		await coordinator.prepareRequest(newModel, context(), [userInput("hello")], { reasoning: { effort: "high" } });
		expect(receivedPayload).toEqual({ reasoning: { effort: "high" } });
	});

	test("coalesces A to B to C before the first request", async () => {
		let compactedWith: string | undefined;
		const coordinator = createCoordinator([], async (selectedModel) => {
			compactedWith = modelKey(selectedModel);
			return details(modelKey(selectedModel));
		});
		const oldModel = model("openai-codex", "old");
		const middleModel = model("openai-codex", "middle");
		const newModel = model("openai-codex", "new");
		await coordinator.selectModel({ model: middleModel, previousModel: oldModel }, context());
		await coordinator.selectModel({ model: newModel, previousModel: middleModel }, context());
		await coordinator.prepareRequest(newModel, context(), [userInput("hello")]);
		expect(compactedWith).toBe(modelKey(oldModel));
	});

	test("runs automatic compaction before the next request and keeps its tail", async () => {
		const branch: SessionEntry[] = [{
			id: "history",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "history" }] },
		} as unknown as SessionEntry];
		const coordinator = createCoordinator(branch, undefined, undefined, () => true);
		const currentModel = model("openai-codex", "current");
		const input = await coordinator.prepareRequest(currentModel, context(), [
			{ role: "user", content: [{ type: "input_text", text: "history" }] },
			userInput("new"),
		]);
		expect(input).toEqual([
			{ type: "compaction", encrypted_content: "opaque" },
			userInput("new"),
		]);
	});

	test("keeps the current user input after an existing checkpoint", async () => {
		const currentModel = model("openai-codex", "current");
		const branch = [checkpointEntry(details(modelKey(currentModel)))];
		const coordinator = createCoordinator(branch);
		const history = details(modelKey(currentModel)).replacementHistory;
		const input = await coordinator.prepareRequest(currentModel, context(), [...history, userInput("new")]);
		expect(input).toEqual([...history, userInput("new")]);
	});

	test("finds the request tail after a real Pi compaction entry", async () => {
		const currentModel = model("openai-codex", "current");
		const oldEntry = {
			id: "old",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "old" }] },
		} as unknown as SessionEntry;
		const branch = [oldEntry, nativeCompactionEntry(details(modelKey(currentModel)), "old")];
		const coordinator = createCoordinator(branch);
		const input = await coordinator.prepareRequest(currentModel, context(), [
			{ role: "user", content: [{ type: "input_text", text: "old" }] },
			userInput("new"),
		]);
		expect(input).toEqual([...details(modelKey(currentModel)).replacementHistory, userInput("new")]);
	});

	test("ignores aborted assistant entries that Pi omits from provider input", async () => {
		const currentModel = model("openai-codex", "current");
		const oldEntry = {
			id: "old",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "old" }] },
		} as unknown as SessionEntry;
		const abortedEntry = {
			id: "aborted",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: { role: "assistant", content: [], stopReason: "aborted" },
		} as unknown as SessionEntry;
		const branch = [oldEntry, nativeCompactionEntry(details(modelKey(currentModel)), "old"), abortedEntry];
		const coordinator = createCoordinator(branch);
		const input = await coordinator.prepareRequest(currentModel, context(), [
			{ role: "user", content: [{ type: "input_text", text: "old" }] },
			userInput("new"),
		]);
		expect(input).toEqual([...details(modelKey(currentModel)).replacementHistory, userInput("new")]);
	});

	test("finds the request tail when Pi sends its raw branch context", async () => {
		const currentModel = model("openai-codex", "current");
		const oldEntry = {
			id: "old",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "old" }] },
		} as unknown as SessionEntry;
		const branch = [oldEntry, checkpointEntry(details(modelKey(currentModel)))];
		const coordinator = createCoordinator(branch);
		const input = await coordinator.prepareRequest(currentModel, context(), [
			{ role: "user", content: [{ type: "input_text", text: "old" }] },
			userInput("new"),
		]);
		expect(input).toEqual([...details(modelKey(currentModel)).replacementHistory, userInput("new")]);
	});

	test("recovers an existing checkpoint for the current model", async () => {
		const oldModel = model("openai-codex", "old");
		const newModel = model("openai-codex", "new");
		const branch = [checkpointEntry(details(modelKey(oldModel)))];
		let createdFor: string | undefined;
		let receivedPayload: Record<string, unknown> | undefined;
		let appended: NativeCompactionDetails | undefined;
		const coordinator = createCoordinator(branch, async (selectedModel, basePayload) => {
			createdFor = modelKey(selectedModel);
			receivedPayload = basePayload;
			return details(modelKey(selectedModel), "new");
		}, (value) => { appended = value; });
		await coordinator.recoverCurrentModel(newModel, context([oldModel, newModel]), { reasoning: { effort: "high" } });
		expect(createdFor).toBe(modelKey(oldModel));
		expect(receivedPayload).toEqual({ reasoning: { effort: "high" } });
		expect(appended?.modelKey).toBe(modelKey(newModel));
	});

	test("skips recovery when checkpoint and current model share a compaction hash", async () => {
		let calls = 0;
		const oldModel = model("openai-codex", "old", "shared");
		const newModel = model("openai-codex", "new", "shared");
		const branch = [checkpointEntry({ ...details(modelKey(oldModel)), compHash: "shared" })];
		const coordinator = createCoordinator(branch, async () => {
			calls++;
			return details("unexpected");
		});
		await coordinator.recoverCurrentModel(newModel, context([oldModel, newModel]));
		expect(calls).toBe(0);
	});

	test("recovers when the same model ID has a different persisted hash", async () => {
		let calls = 0;
		const previous = model("openai-codex", "same", "hash-a");
		const current = model("openai-codex", "same", "hash-b");
		const branch = [checkpointEntry({ ...details(modelKey(previous)), compHash: "hash-a" })];
		const coordinator = createCoordinator(branch, async () => {
			calls++;
			return details(modelKey(current));
		});
		await coordinator.recoverCurrentModel(current, context([current]));
		expect(calls).toBe(1);
	});

	test("replays a same-hash checkpoint through prepareRequest", async () => {
		const previous = model("openai-codex", "previous", "shared");
		const current = model("openai-codex", "current", "shared");
		const branch = [checkpointEntry({ ...details(modelKey(previous)), compHash: "shared" })];
		let calls = 0;
		const coordinator = createCoordinator(branch, async () => {
			calls++;
			return details("unexpected");
		});
		const input = [...details(modelKey(previous)).replacementHistory, userInput("hello")];
		await expect(coordinator.prepareRequest(current, context([previous, current]), input)).resolves.toEqual(input);
		expect(calls).toBe(0);
	});

	test("falls back to the current model when the checkpoint model is unavailable", async () => {
		let createdFor: string | undefined;
		const oldModel = model("openai-codex", "retired", "hash-old");
		const newModel = model("openai-codex", "current", "hash-new");
		const branch = [checkpointEntry({ ...details(modelKey(oldModel)), compHash: "hash-old" })];
		const coordinator = createCoordinator(branch, async (selectedModel) => {
			createdFor = modelKey(selectedModel);
			return details(modelKey(selectedModel));
		});
		await coordinator.recoverCurrentModel(newModel, context([newModel]));
		expect(createdFor).toBe(modelKey(newModel));
	});

	test("uses current-model recovery fallback through prepareRequest", async () => {
		let createdFor: string | undefined;
		const oldModel = model("openai-codex", "retired", "hash-old");
		const newModel = model("openai-codex", "current", "hash-new");
		const branch = [checkpointEntry({ ...details(modelKey(oldModel)), compHash: "hash-old" })];
		const coordinator = createCoordinator(branch, async (selectedModel) => {
			createdFor = modelKey(selectedModel);
			return details(modelKey(selectedModel));
		});
		const input = [...details(modelKey(oldModel)).replacementHistory, userInput("hello")];
		await coordinator.prepareRequest(newModel, context([newModel]), input);
		expect(createdFor).toBe(modelKey(newModel));
	});

	test("recovers a pending transition after reload with the checkpoint model", async () => {
		const oldModel = model("openai-codex", "old");
		const newModel = model("openai-codex", "new");
		const branch = [checkpointEntry(details(modelKey(oldModel)))];
		let compactedWith: string | undefined;
		const coordinator = createCoordinator(branch, async (selectedModel) => {
			compactedWith = modelKey(selectedModel);
			return details(modelKey(selectedModel), "recovered");
		});
		const input = await coordinator.prepareRequest(newModel, context([oldModel, newModel]), [
			...details(modelKey(oldModel)).replacementHistory,
			userInput("hello"),
		]);
		expect(compactedWith).toBe(modelKey(oldModel));
		expect(input).toEqual([{ type: "compaction", encrypted_content: "recovered" }, userInput("hello")]);
	});

	test("falls back to the current model when the previous model fails", async () => {
		const compactedWith: string[] = [];
		const oldModel = model("openai-codex", "old");
		const newModel = model("openai-codex", "new");
		const coordinator = createCoordinator([], async (selectedModel) => {
			compactedWith.push(modelKey(selectedModel));
			if (selectedModel.id === oldModel.id) throw new Error("old model unavailable");
			return details(modelKey(selectedModel), "fallback");
		});
		await coordinator.selectModel({ model: newModel, previousModel: oldModel }, context());
		const input = await coordinator.prepareRequest(newModel, context(), [userInput("hello")]);
		expect(compactedWith).toEqual([modelKey(oldModel), modelKey(newModel)]);
		expect(input).toEqual([{ type: "compaction", encrypted_content: "fallback" }, userInput("hello")]);
	});

	test("records a failed transition only when the first request runs", async () => {
		const failing = createCoordinator([], async () => { throw new Error("remote unavailable"); });
		const oldModel = model("openai-codex", "old");
		const newModel = model("openai-codex", "new");
		await failing.selectModel({ model: newModel, previousModel: oldModel }, context());
		expect(failing.transitionFailure("session", newModel)).toBeUndefined();
		await failing.prepareRequest(newModel, context(), [userInput("hello")]).catch(() => {});
		expect(failing.transitionFailure("session", newModel)).toBe("remote unavailable; current-model fallback failed: remote unavailable");
		await failing.selectModel({ model: model("anthropic", "claude"), previousModel: newModel }, context());
		expect(failing.transitionFailure("session", newModel)).toBeUndefined();
	});
});

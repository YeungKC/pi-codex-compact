import { describe, expect, test } from "vitest";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { createSessionCoordinator } from "./session-coordinator.ts";
import {
	effectiveInputForBranch,
	findNativeCheckpoint,
	modelKey,
	FAILED_REQUEST_KIND,
	NATIVE_COMPACTION_KIND,
	NATIVE_COMPACTION_VERSION,
	type NativeCompactionDetails,
	type ResponseItem,
} from "./native-compaction.ts";

const CATALOG_IDS: Record<string, string> = {
	old: "gpt-5.5",
	new: "gpt-5.6-sol",
	other: "gpt-5.4",
	unknown: "gpt-5.2",
	unknownOther: "codex-auto-review",
};

function model(name: string, provider = "openai-codex", contextWindow = 100_000): Model<any> {
	const id = provider === "openai-codex" ? (CATALOG_IDS[name] ?? name) : name;
	return {
		provider,
		api: provider === "openai-codex" ? "openai-codex-responses" : "other-api",
		id,
		reasoning: true,
		contextWindow,
	} as Model<any>;
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
		version: NATIVE_COMPACTION_VERSION,
		strategy: "v2",
		modelKey: key,
		replacementHistory: [{ type: "compaction", encrypted_content: encrypted }],
	};
}

function customEntry(data: unknown, id = "checkpoint", customType = NATIVE_COMPACTION_KIND): SessionEntry {
	return {
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "custom",
		customType,
		data,
	} as unknown as SessionEntry;
}

function userEntry(text: string, id = "user"): SessionEntry {
	return {
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "message",
		message: { role: "user", content: [{ type: "text", text }] },
	} as unknown as SessionEntry;
}

function userInput(text: string): ResponseItem {
	return { role: "user", content: [{ type: "input_text", text }] };
}

function createCoordinator(
	branch: SessionEntry[] = [],
	createCheckpoint?: (selectedModel: Model<any>, input: ResponseItem[], basePayload?: Record<string, unknown>) => Promise<NativeCompactionDetails>,
	shouldAutoCompact?: (input: ResponseItem[]) => boolean,
) {
	return createSessionCoordinator({
		getBranch: () => branch,
		getAllTools: () => [],
		createCheckpoint: async ({ model: selectedModel, input, basePayload }) => ({
			details: createCheckpoint
				? await createCheckpoint(selectedModel, input, basePayload)
				: details(modelKey(selectedModel)),
		}),
		appendCheckpoint: (value) => branch.push(customEntry(value)),
		appendFailedRequest: (value) => branch.push(customEntry(value, "failed-request", FAILED_REQUEST_KIND)),
		shouldAutoCompact: shouldAutoCompact ? ({ input }) => shouldAutoCompact(input) : undefined,
	});
}

describe("Codex session coordinator", () => {
	test("does not replay a failed user before a later request", async () => {
		const currentModel = model("new");
		const branch = [customEntry(details(modelKey(currentModel))), userEntry("failed", "failed-user")];
		const coordinator = createCoordinator(branch);
		const ctx = context([currentModel]);
		coordinator.recordFailedRequest(ctx, [
			{ type: "compaction", encrypted_content: "opaque" },
			userInput("failed"),
		]);

		await expect(coordinator.prepareRequest(currentModel, ctx, [
			{ type: "compaction", encrypted_content: "opaque" },
			userInput("failed"),
			userInput("new request"),
		])).resolves.toEqual([
			{ type: "compaction", encrypted_content: "opaque" },
			userInput("new request"),
		]);
	});

	test("keeps a failed user as the next retry input", async () => {
		const currentModel = model("new");
		const branch = [customEntry(details(modelKey(currentModel))), userEntry("failed", "failed-user")];
		const coordinator = createCoordinator(branch);
		const ctx = context([currentModel]);
		coordinator.recordFailedRequest(ctx, [
			{ type: "compaction", encrypted_content: "opaque" },
			userInput("failed"),
		]);

		await expect(coordinator.prepareRequest(currentModel, ctx, [
			{ type: "compaction", encrypted_content: "opaque" },
			userInput("failed"),
		])).resolves.toEqual([
			{ type: "compaction", encrypted_content: "opaque" },
			userInput("failed"),
		]);
	});

	test("removes the nearest failed duplicate, not an older matching user", async () => {
		const currentModel = model("new");
		const branch = [
			customEntry(details(modelKey(currentModel))),
			userEntry("same", "older"),
			userEntry("same", "failed-user"),
		];
		const coordinator = createCoordinator(branch);
		const ctx = context([currentModel]);
		coordinator.recordFailedRequest(ctx, [
			{ type: "compaction", encrypted_content: "opaque" },
			userInput("same"),
		]);

		await expect(coordinator.prepareRequest(currentModel, ctx, [
			{ type: "compaction", encrypted_content: "opaque" },
			userInput("same"),
			userInput("same"),
			userInput("new"),
		])).resolves.toEqual([
			{ type: "compaction", encrypted_content: "opaque" },
			userInput("same"),
			userInput("new"),
		]);
	});

	test("skips model-transition compaction when either hash is absent", async () => {
		const oldModel = model("unknown");
		const currentModel = model("unknownOther");
		let calls = 0;
		const coordinator = createCoordinator([], async () => {
			calls++;
			return details(modelKey(currentModel));
		});

		await coordinator.selectModel({ model: currentModel, previousModel: oldModel }, context([oldModel, currentModel]));
		await expect(coordinator.prepareRequest(currentModel, context([oldModel, currentModel]), [userInput("hello")])).resolves.toBeUndefined();
		expect(calls).toBe(0);
	});

	test("compacts on the first request after a known hash transition", async () => {
		const oldModel = model("old");
		const currentModel = model("new");
		const compactedWith: string[] = [];
		const coordinator = createCoordinator([], async (selectedModel) => {
			compactedWith.push(modelKey(selectedModel));
			return details(modelKey(selectedModel));
		});

		await coordinator.selectModel({ model: currentModel, previousModel: oldModel }, context([oldModel, currentModel]));
		const input = await coordinator.prepareRequest(currentModel, context([oldModel, currentModel]), [userInput("hello")]);

		expect(compactedWith).toEqual([modelKey(oldModel)]);
		expect(input).toEqual([{ type: "compaction", encrypted_content: "opaque" }, userInput("hello")]);
	});

	test("recovers a model transition when a resumed session has no model-change entry", async () => {
		const oldModel = model("old");
		const currentModel = model("new");
		const branch = [{
			id: "assistant",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: {
				role: "assistant",
				provider: oldModel.provider,
				api: oldModel.api,
				model: oldModel.id,
				content: [{ type: "text", text: "answer" }],
			},
		} as unknown as SessionEntry];
		const compactedWith: string[] = [];
		const coordinator = createCoordinator(branch, async (selectedModel) => {
			compactedWith.push(modelKey(selectedModel));
			return details(modelKey(selectedModel), "resumed");
		});

		const input = await coordinator.prepareRequest(currentModel, context([oldModel, currentModel]), [userInput("hello")]);

		expect(compactedWith).toEqual([modelKey(oldModel)]);
		expect(input).toEqual([{ type: "compaction", encrypted_content: "resumed" }, userInput("hello")]);
	});

	test("compacts on a context-window downshift only at the auto limit", async () => {
		const oldModel = model("old", "openai-codex", 200_000);
		const currentModel = model("other", "openai-codex", 100_000);
		let calls = 0;
		let thresholdChecks = 0;
		const coordinator = createCoordinator([], async (selectedModel) => {
			calls++;
			return details(modelKey(selectedModel), "downshift");
		}, () => thresholdChecks++ === 0);

		await coordinator.selectModel({ model: currentModel, previousModel: oldModel }, context([oldModel, currentModel]));
		await expect(coordinator.prepareRequest(currentModel, context([oldModel, currentModel]), [userInput("hello")])).resolves.toEqual([
			{ type: "compaction", encrypted_content: "downshift" },
			userInput("hello"),
		]);
		expect(calls).toBe(1);
	});

	test("uses the current model only for an eligible transition failure", async () => {
		const oldModel = model("old");
		const currentModel = model("new");
		const compactedWith: string[] = [];
		const coordinator = createCoordinator([], async (selectedModel) => {
			compactedWith.push(modelKey(selectedModel));
			if (selectedModel === oldModel) {
				const error = new Error("context_length_exceeded") as Error & { retryWithCurrentModel: boolean };
				Object.defineProperty(error, "retryWithCurrentModel", { value: true });
				throw error;
			}
			return details(modelKey(selectedModel), "fallback");
		});

		await coordinator.selectModel({ model: currentModel, previousModel: oldModel }, context([oldModel, currentModel]));
		await expect(coordinator.prepareRequest(currentModel, context([oldModel, currentModel]), [userInput("hello")])).resolves.toEqual([
			{ type: "compaction", encrypted_content: "fallback" },
			userInput("hello"),
		]);
		expect(compactedWith).toEqual([modelKey(oldModel), modelKey(currentModel)]);
	});

	test("does not permanently block a transition after a non-fallback failure", async () => {
		const oldModel = model("old");
		const currentModel = model("new");
		let calls = 0;
		const coordinator = createCoordinator([], async (selectedModel) => {
			calls++;
			if (calls === 1) {
				const error = new Error("policy_violation") as Error & { retryWithCurrentModel: boolean };
				Object.defineProperty(error, "retryWithCurrentModel", { value: false });
				throw error;
			}
			return details(modelKey(selectedModel), "retry-success");
		});

		await coordinator.selectModel({ model: currentModel, previousModel: oldModel }, context([oldModel, currentModel]));
		await expect(coordinator.prepareRequest(currentModel, context([oldModel, currentModel]), [userInput("hello")])).rejects.toThrow("policy_violation");
		await expect(coordinator.prepareRequest(currentModel, context([oldModel, currentModel]), [userInput("hello")])).resolves.toEqual([
			{ type: "compaction", encrypted_content: "retry-success" },
			userInput("hello"),
		]);
		expect(calls).toBe(2);
	});

	test("replays a checkpoint when the current model has no comparable hash", async () => {
		const oldModel = model("old");
		const currentModel = model("unknown");
		const branch = [customEntry({ ...details(modelKey(oldModel)), compHash: "2911" })];
		let calls = 0;
		const coordinator = createCoordinator(branch, async () => {
			calls++;
			return details("unexpected");
		});

		const input = [{ type: "compaction", encrypted_content: "opaque" }, userInput("hello")];
		await expect(coordinator.prepareRequest(currentModel, context([oldModel, currentModel]), input)).resolves.toEqual(input);
		expect(calls).toBe(0);
	});

	test("recovers a context overflow with the newest complete history turn", async () => {
		const currentModel = model("old", "openai-codex", 100);
		const oldText = "old ".repeat(100);
		const newText = "new ".repeat(5);
		const branch = [userEntry(oldText), userEntry(newText)];
		let compactedInput: ResponseItem[] | undefined;
		const coordinator = createCoordinator(branch, async (_selectedModel, input) => {
			compactedInput = input;
			return details(modelKey(currentModel), "recovered");
		});
		const toolOutput = { type: "function_call_output", call_id: "call", output: "tool result" };
		const request = [userInput(oldText), userInput(newText), userInput("current"), toolOutput];

		await expect(coordinator.prepareRequest(
			currentModel,
			context([currentModel]),
			request,
			undefined,
			false,
			"context-overflow",
		)).resolves.toEqual([
			{ type: "compaction", encrypted_content: "recovered" },
			userInput("current"),
			toolOutput,
		]);
		expect(compactedInput).toEqual([userInput(newText)]);
		expect(effectiveInputForBranch({ branch, model: currentModel, tools: [] })).toEqual([
			{ type: "compaction", encrypted_content: "recovered" },
			userInput("current"),
			toolOutput,
		]);
	});

	test("does not infer a missing persisted hash from the checkpoint model", async () => {
		const oldModel = model("old");
		const currentModel = model("new");
		const branch = [customEntry(details(modelKey(oldModel)))];
		let calls = 0;
		const coordinator = createCoordinator(branch, async () => {
			calls++;
			return details("unexpected");
		});

		const input = [{ type: "compaction", encrypted_content: "opaque" }, userInput("hello")];
		await expect(coordinator.prepareRequest(currentModel, context([oldModel, currentModel]), input)).resolves.toEqual(input);
		expect(calls).toBe(0);
	});

	test("ignores an unsupported V1 checkpoint and leaves Pi's normal history unchanged", async () => {
		const currentModel = model("old");
		const branch = [
			userEntry("old history"),
			customEntry({
				kind: NATIVE_COMPACTION_KIND,
				version: 2,
				strategy: "v1",
				modelKey: modelKey(currentModel),
				replacementHistory: [{ type: "compaction", encrypted_content: "old" }],
			}),
		];
		let calls = 0;
		const coordinator = createCoordinator(branch, async () => {
			calls++;
			return details(modelKey(currentModel));
		});

		await expect(coordinator.prepareRequest(
			currentModel,
			context([currentModel]),
			[userInput("old history"), userInput("new request")],
		)).resolves.toBeUndefined();
		expect(calls).toBe(0);
		expect(findNativeCheckpoint(branch).status).toBe("none");
	});

	test("leaves a malformed current checkpoint to Pi's normal history", async () => {
		const currentModel = model("old");
		const branch = [
			userEntry("old"),
			userEntry("hello"),
			customEntry({
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				strategy: "v2",
				modelKey: modelKey(currentModel),
				replacementHistory: [],
			}),
		];
		const coordinator = createCoordinator(branch);

		await expect(coordinator.prepareRequest(currentModel, context([currentModel]), [userInput("old"), userInput("hello")])).resolves.toBeUndefined();
	});

	test("preserves a persisted current user without duplicating it", async () => {
		const oldModel = model("old");
		const currentModel = model("new");
		const branch = [userEntry("current")];
		let compactedInput: ResponseItem[] | undefined;
		const coordinator = createCoordinator(branch, async (_selectedModel, input) => {
			compactedInput = input;
			return details(modelKey(currentModel), "transition");
		});

		await coordinator.selectModel({ model: currentModel, previousModel: oldModel }, context([oldModel, currentModel]));
		const input = await coordinator.prepareRequest(currentModel, context([oldModel, currentModel]), [userInput("current")]);

		expect(compactedInput).toEqual([]);
		expect(input).toEqual([{ type: "compaction", encrypted_content: "transition" }, userInput("current")]);
	});

	test("does not drop a new user that repeats a preserved user's content", async () => {
		const currentModel = model("old");
		const branch = [customEntry({ ...details(modelKey(currentModel)), preservedInput: [userInput("same")] }), userEntry("same", "current")];
		const coordinator = createCoordinator(branch);

		await expect(coordinator.prepareRequest(currentModel, context([currentModel]), [
			{ type: "compaction", encrypted_content: "opaque" },
			userInput("same"),
			userInput("same"),
		])).resolves.toEqual([
			{ type: "compaction", encrypted_content: "opaque" },
			userInput("same"),
			userInput("same"),
		]);
	});

	test("keeps a duplicate user after omitted pre-checkpoint history", async () => {
		const currentModel = model("old");
		const branch = [
			userEntry("old"),
			userEntry("same"),
			customEntry({
				...details(modelKey(currentModel)),
				preservedInput: [userInput("same")],
			}),
		];
		const coordinator = createCoordinator(branch);

		await expect(coordinator.prepareRequest(currentModel, context([currentModel]), [
			{ type: "compaction", encrypted_content: "opaque" },
			userInput("same"),
			userInput("same"),
		])).resolves.toEqual([
			{ type: "compaction", encrypted_content: "opaque" },
			userInput("same"),
			userInput("same"),
		]);
	});

	test("keeps a new same-text user after a checkpoint preserves the prior turn", async () => {
		const currentModel = model("old");
		const oldUser = { type: "message", id: "old-turn", role: "user", content: [{ type: "input_text", text: "same" }] };
		const newUser = { type: "message", id: "new-turn", role: "user", content: [{ type: "input_text", text: "same" }] };
		const branch = [
			userEntry("same", "old-entry"),
			{
				id: "assistant",
				parentId: null,
				timestamp: new Date().toISOString(),
				type: "message",
				message: { role: "assistant", provider: currentModel.provider, api: currentModel.api, model: currentModel.id, content: [{ type: "text", text: "answer" }] },
			} as never,
			customEntry({
				...details(modelKey(currentModel)),
				replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
				preservedInput: [oldUser],
			}),
		];
		const coordinator = createCoordinator(branch);
		const prefix = effectiveInputForBranch({ branch, model: currentModel, tools: [], allowCheckpointModelMismatch: true });

		const result = await coordinator.prepareRequest(currentModel, context([currentModel]), [...prefix, newUser]);
		expect(result?.at(-1)).toEqual(newUser);
		expect(result?.find((item) => item.id === "new-turn")).toEqual(newUser);
	});

	test("manual compaction does not run model-transition compaction", async () => {
		const oldModel = model("old");
		const currentModel = model("new");
		const branch = [userEntry("history")];
		const compactedWith: string[] = [];
		const coordinator = createCoordinator(branch, async (selectedModel) => {
			compactedWith.push(modelKey(selectedModel));
			return details(modelKey(selectedModel), "transition");
		});

		await coordinator.selectModel({ model: currentModel, previousModel: oldModel }, context([oldModel, currentModel]));
		await expect(coordinator.prepareCompaction(currentModel, context([oldModel, currentModel]), [userInput("history")])).resolves.toEqual([userInput("history")]);
		expect(compactedWith).toEqual([]);
	});

	test("manual compaction still honors cancellation", async () => {
		const currentModel = model("current");
		const controller = new AbortController();
		controller.abort(new Error("canceled"));
		const coordinator = createCoordinator([userEntry("history")]);

		await expect(coordinator.prepareCompaction(
			currentModel,
			context([currentModel]),
			[userInput("history")],
			false,
			controller.signal,
		)).rejects.toThrow("canceled");
	});

	test("runs automatic compaction before the provider request", async () => {
		const currentModel = model("old");
		const branch = [userEntry("history")];
		let compactedInput: ResponseItem[] | undefined;
		const coordinator = createCoordinator(
			branch,
			async (_selectedModel, input) => {
				compactedInput = input;
				return details(modelKey(currentModel), "automatic");
			},
			() => true,
		);

		const input = await coordinator.prepareRequest(currentModel, context([currentModel]), [userInput("history"), userInput("new")]);
		expect(compactedInput).toEqual([userInput("history")]);
		expect(input).toEqual([{ type: "compaction", encrypted_content: "automatic" }, userInput("new")]);
	});

	test("preserves a duplicate current user during automatic compaction", async () => {
		const currentModel = model("old");
		const branch = [userEntry("same", "old-entry")];
		const oldUser = { type: "message", id: "old-turn", role: "user", content: [{ type: "input_text", text: "same" }] };
		const coordinator = createCoordinator(
			branch,
			async (_selectedModel, input) => {
				expect(input).toEqual([userInput("same")]);
				return {
					...details(modelKey(currentModel), "automatic"),
					replacementHistory: [oldUser, { type: "compaction", encrypted_content: "automatic" }],
				};
			},
			() => true,
		);

		const input = await coordinator.prepareRequest(currentModel, context([currentModel]), [userInput("same"), userInput("same")]);
		expect(input?.filter((item) => item.role === "user")).toEqual([oldUser, userInput("same")]);
	});

	test("does not duplicate a user across transition and automatic compaction", async () => {
		const oldModel = model("old");
		const currentModel = model("new");
		const branch = [userEntry("current")];
		let calls = 0;
		const coordinator = createCoordinator(
			branch,
			async (selectedModel, input) => {
				calls++;
				if (calls === 1) {
					expect(selectedModel).toBe(oldModel);
					expect(input).toEqual([]);
					return details(modelKey(oldModel), "transition");
				}
				expect(selectedModel).toBe(currentModel);
				expect(input).toEqual([{ type: "compaction", encrypted_content: "transition" }, userInput("current")]);
				return {
					...details(modelKey(currentModel), "automatic"),
					replacementHistory: [userInput("current"), { type: "compaction", encrypted_content: "automatic" }],
				};
			},
			() => true,
		);

		await coordinator.selectModel({ model: currentModel, previousModel: oldModel }, context([oldModel, currentModel]));
		const input = await coordinator.prepareRequest(currentModel, context([oldModel, currentModel]), [userInput("current")]);

		expect(calls).toBe(2);
		expect(input?.filter((item) => item.role === "user")).toEqual([userInput("current")]);
	});

	test("uses the current model for a persisted known hash when the old model is unavailable", async () => {
		const currentModel = model("new");
		const retiredKey = "openai-codex:openai-codex-responses:gpt-5.5";
		const branch = [customEntry({ ...details(retiredKey), compHash: "2911" })];
		let usedModel: string | undefined;
		const coordinator = createCoordinator(branch, async (selectedModel) => {
			usedModel = modelKey(selectedModel);
			return details(modelKey(selectedModel), "recovered");
		});

		await coordinator.recoverCurrentModel(currentModel, context([currentModel]));
		expect(usedModel).toBe(modelKey(currentModel));
	});

});

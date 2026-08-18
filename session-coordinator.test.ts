import { describe, expect, test } from "vitest";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { createSessionCoordinator } from "./session-coordinator.ts";
import {
	findNativeCheckpoint,
	fullInputForBranch,
	modelKey,
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

function legacyDetails(key: string): Record<string, unknown> {
	return {
		kind: NATIVE_COMPACTION_KIND,
		version: 1,
		strategy: "v2",
		modelKey: key,
		replacementHistory: [{ type: "compaction", encrypted_content: "old" }],
	};
}

function customEntry(data: unknown, id = "checkpoint"): SessionEntry {
	return {
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "custom",
		customType: NATIVE_COMPACTION_KIND,
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
		withStatus: async (_ctx, operation) => operation(),
		appendCheckpoint: (value) => branch.push(customEntry(value)),
		shouldAutoCompact: shouldAutoCompact ? ({ input }) => shouldAutoCompact(input) : undefined,
	});
}

describe("Codex session coordinator", () => {
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

	test("migrates a legacy checkpoint from the full branch on first request", async () => {
		const currentModel = model("old");
		const branch = [userEntry("old history"), customEntry(legacyDetails(modelKey(currentModel)))];
		let compactedInput: ResponseItem[] | undefined;
		const coordinator = createCoordinator(branch, async (_selectedModel, input) => {
			compactedInput = input;
			return details(modelKey(currentModel), "migrated");
		});
		const request = [userInput("old history"), userInput("new request")];

		const input = await coordinator.prepareRequest(currentModel, context([currentModel]), request);

		expect(compactedInput).toEqual([userInput("old history")]);
		expect(input).toEqual([{ type: "compaction", encrypted_content: "migrated" }, userInput("new request")]);
		expect(findNativeCheckpoint(branch).status).toBe("valid");
	});

	test("migrates legacy state even when Pi changes the request prefix", async () => {
		const currentModel = model("old");
		const branch = [userEntry("old history"), customEntry(legacyDetails(modelKey(currentModel)))];
		let compactedInput: ResponseItem[] | undefined;
		const coordinator = createCoordinator(branch, async (_selectedModel, input) => {
			compactedInput = input;
			return details(modelKey(currentModel), "migrated");
		});

		await expect(coordinator.prepareRequest(currentModel, context([currentModel]), [userInput("new request")])).resolves.toEqual([
			{ type: "compaction", encrypted_content: "migrated" },
			userInput("new request"),
		]);
		expect(compactedInput).toEqual([userInput("old history")]);
	});

	test("preserves the transformed request tail during legacy migration", async () => {
		const currentModel = model("old");
		const branch = [userEntry("old history"), customEntry(legacyDetails(modelKey(currentModel)))];
		const coordinator = createCoordinator(branch, async (_selectedModel, input) => {
			expect(input).toEqual([userInput("old history")]);
			return details(modelKey(currentModel), "migrated");
		});
		const request = [
			userInput("new request"),
			{ type: "function_call_output", call_id: "call", output: "tool result" },
		];

		await expect(coordinator.prepareRequest(currentModel, context([currentModel]), request)).resolves.toEqual([
			{ type: "compaction", encrypted_content: "migrated" },
			...request,
		]);
	});

	test("preserves unmatched transformed items around legacy history", async () => {
		const currentModel = model("old");
		const branch = [userEntry("one", "one"), userEntry("two", "two"), customEntry(legacyDetails(modelKey(currentModel)))];
		const coordinator = createCoordinator(branch, async (_selectedModel, input) => {
			expect(input).toEqual([userInput("one"), userInput("two")]);
			return details(modelKey(currentModel), "migrated");
		});
		const request = [userInput("prefix"), userInput("one"), userInput("middle"), userInput("two"), userInput("new")];

		await expect(coordinator.prepareRequest(currentModel, context([currentModel]), request)).resolves.toEqual([
			{ type: "compaction", encrypted_content: "migrated" },
			userInput("prefix"),
			userInput("middle"),
			userInput("new"),
		]);
	});

	test("does not duplicate history after a missing transformed item", async () => {
		const currentModel = model("old");
		const branch = [userEntry("a", "a"), userEntry("b", "b"), userEntry("c", "c"), customEntry(legacyDetails(modelKey(currentModel)))];
		const coordinator = createCoordinator(branch, async (_selectedModel, input) => {
			expect(input).toEqual([userInput("a"), userInput("b"), userInput("c")]);
			return details(modelKey(currentModel), "migrated");
		});
		const request = [userInput("a"), userInput("inserted"), userInput("c"), userInput("new")];

		await expect(coordinator.prepareRequest(currentModel, context([currentModel]), request)).resolves.toEqual([
			{ type: "compaction", encrypted_content: "migrated" },
			userInput("inserted"),
			userInput("new"),
		]);
	});

	test("uses the legacy checkpoint model before falling back to the current model", async () => {
		const oldModel = model("old");
		const currentModel = model("new");
		const branch = [userEntry("old history"), customEntry(legacyDetails(modelKey(oldModel)))];
		let usedModel: string | undefined;
		const coordinator = createCoordinator(branch, async (selectedModel) => {
			usedModel = modelKey(selectedModel);
			return details(modelKey(selectedModel), "migrated");
		});

		await coordinator.prepareRequest(currentModel, context([oldModel, currentModel]), [userInput("old history"), userInput("new request")]);
		expect(usedModel).toBe(modelKey(oldModel));
	});

	test("retries legacy migration on a later request after failure", async () => {
		const currentModel = model("old");
		const branch = [userEntry("old history"), customEntry(legacyDetails(modelKey(currentModel)))];
		let calls = 0;
		const coordinator = createCoordinator(branch, async () => {
			calls++;
			if (calls === 1) throw new Error("temporary unavailable");
			return details(modelKey(currentModel), "migrated");
		});
		const request = [userInput("old history"), userInput("new request")];

		await expect(coordinator.prepareRequest(currentModel, context([currentModel]), request)).rejects.toThrow("temporary unavailable");
		await expect(coordinator.prepareRequest(currentModel, context([currentModel]), request)).resolves.toEqual([
			{ type: "compaction", encrypted_content: "migrated" },
			userInput("new request"),
		]);
		expect(calls).toBe(2);
	});

	test("does not replay a malformed current checkpoint", async () => {
		const currentModel = model("old");
		const branch = [customEntry({
			kind: NATIVE_COMPACTION_KIND,
			version: NATIVE_COMPACTION_VERSION,
			strategy: "v2",
			modelKey: modelKey(currentModel),
			replacementHistory: [],
		})];
		const coordinator = createCoordinator(branch);

		await expect(coordinator.prepareRequest(currentModel, context([currentModel]), [userInput("hello")])).rejects.toThrow("malformed");
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

	test("prepares explicit compaction after a model transition", async () => {
		const oldModel = model("old");
		const currentModel = model("new");
		const branch = [userEntry("history")];
		const compactedWith: string[] = [];
		const coordinator = createCoordinator(branch, async (selectedModel) => {
			compactedWith.push(modelKey(selectedModel));
			return details(modelKey(selectedModel), "transition");
		});

		await coordinator.selectModel({ model: currentModel, previousModel: oldModel }, context([oldModel, currentModel]));
		await expect(coordinator.prepareCompaction(currentModel, context([oldModel, currentModel]), [userInput("history")])).resolves.toEqual([
			{ type: "compaction", encrypted_content: "transition" },
			userInput("history"),
		]);
		expect(compactedWith).toEqual([modelKey(oldModel)]);
	});

	test("does not append a canceled explicit transition checkpoint", async () => {
		const oldModel = model("old");
		const currentModel = model("new");
		const branch = [userEntry("history")];
		const controller = new AbortController();
		const coordinator = createCoordinator(branch, async (selectedModel) => {
			if (selectedModel === oldModel) controller.abort(new Error("canceled"));
			return details(modelKey(selectedModel), "canceled");
		});

		await coordinator.selectModel({ model: currentModel, previousModel: oldModel }, context([oldModel, currentModel]));
		await expect(coordinator.prepareCompaction(
			currentModel,
			context([oldModel, currentModel]),
			[userInput("history")],
			undefined,
			false,
			controller.signal,
		)).rejects.toThrow("canceled");
		expect(branch).toHaveLength(1);
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

	test("keeps the provider payload tail after a transition", async () => {
		const oldModel = model("old");
		const currentModel = model("new");
		const coordinator = createCoordinator([], async (selectedModel) => details(modelKey(selectedModel), "transition"));

		await coordinator.selectModel({ model: currentModel, previousModel: oldModel }, context([oldModel, currentModel]));
		const input = await coordinator.prepareRequest(currentModel, context([oldModel, currentModel]), [userInput("history"), userInput("new")]);
		expect(input?.at(-1)).toEqual(userInput("new"));
	});

	test("fullInputForBranch remains the legacy migration source", () => {
		const currentModel = model("old");
		const branch = [userEntry("one"), customEntry(legacyDetails(modelKey(currentModel)))];
		expect(fullInputForBranch({ branch, model: currentModel, tools: [] })).toEqual([userInput("one")]);
	});
});

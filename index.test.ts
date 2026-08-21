import { expect, test, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import codexCompactionExtension from "./index.ts";
import { FAILED_REQUEST_KIND, NATIVE_COMPACTION_KIND } from "./native-compaction.ts";

type Handler = (event: any, ctx: any) => unknown;

const apiKey = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.c`;

function checkpointEntry(): SessionEntry {
	return {
		id: "checkpoint",
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "custom",
		customType: NATIVE_COMPACTION_KIND,
		data: {
			kind: NATIVE_COMPACTION_KIND,
			version: 2,
			strategy: "v2",
			modelKey: "openai-codex:openai-codex-responses:gpt",
			replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
		},
	} as unknown as SessionEntry;
}

function installExtension(branch: SessionEntry[] = [], hasUI = false) {
	const handlers = new Map<string, Handler>();
	const notify = vi.fn();
	const model = {
		provider: "openai-codex",
		api: "openai-codex-responses",
		id: "gpt",
		contextWindow: 100_000,
		reasoning: true,
		compat: {},
	};
	const sessionManager = {
		getSessionId: () => "session",
		getBranch: () => branch,
	};
	const ctx = {
		cwd: process.cwd(),
		isProjectTrusted: () => true,
		hasUI,
		ui: { notify },
		abort: vi.fn(),
		signal: new AbortController().signal,
		model,
		thinkingLevel: "high",
		getSystemPrompt: () => "system instructions",
		sessionManager,
		modelRegistry: {
			find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey,
				headers: {},
				baseUrl: "https://example.test/backend-api",
			}),
		},
	};
	const appendEntry = vi.fn();
	codexCompactionExtension({
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getAllTools: () => [],
		getActiveTools: () => [],
		appendEntry,
	} as never);
	return { handlers, ctx, model, notify, appendEntry };
}

test("removes unsupported prompt cache retention from Codex requests", async () => {
	const { handlers, ctx } = installExtension();
	const payload = { input: [], prompt_cache_retention: "24h" };

	await expect(handlers.get("before_provider_request")?.({ payload }, ctx)).resolves.toBe(payload);
	expect(payload).not.toHaveProperty("prompt_cache_retention");
});

test("returns sanitized input after filtering a stale failed marker", async () => {
	const secret = "stale-failed-input";
	const branch = [
		{
			id: "failed-user",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: { role: "user", content: [{ type: "text", text: secret }] },
		},
		{
			id: "failed-marker",
			parentId: "failed-user",
			timestamp: new Date().toISOString(),
			type: "custom",
			customType: FAILED_REQUEST_KIND,
			data: { kind: FAILED_REQUEST_KIND, entryId: "failed-user" },
		},
	] as never;
	const { handlers, ctx } = installExtension(branch);
	const result = await handlers.get("before_provider_request")?.({
		payload: {
			input: [
				{ role: "user", content: [{ type: "input_text", text: secret }] },
				{ role: "user", content: [{ type: "input_text", text: "retry" }] },
			],
		},
	}, ctx);

	expect(result).toEqual({ input: [{ role: "user", content: [{ type: "input_text", text: "retry" }] }] });
	expect(JSON.stringify(result)).not.toContain(secret);
	expect(ctx.abort).not.toHaveBeenCalled();
});

test("filters Pi compaction summaries after a valid V2 checkpoint", () => {
	const { handlers, ctx } = installExtension([checkpointEntry()]);

	const result = handlers.get("context")?.(
		{
			messages: [
				{ role: "compactionSummary", content: [{ type: "text", text: "OLD SUMMARY" }] },
				{ role: "user", content: [{ type: "text", text: "keep" }] },
			],
		},
		ctx,
	);

	expect(result).toEqual({ messages: [{ role: "user", content: [{ type: "text", text: "keep" }] }] });
});

test("replays the full branch when a native checkpoint is malformed", () => {
	const branch = [
		{ id: "old", type: "message", message: { role: "user", content: [{ type: "text", text: "old" }] } },
		{ id: "kept", type: "message", message: { role: "user", content: [{ type: "text", text: "kept" }] } },
		{
			id: "malformed",
			parentId: "kept",
			timestamp: new Date().toISOString(),
			type: "compaction",
			summary: "OLD SUMMARY",
			firstKeptEntryId: "kept",
			tokensBefore: 123,
			details: {
				kind: NATIVE_COMPACTION_KIND,
				version: 2,
				strategy: "v2",
				modelKey: "openai-codex:openai-codex-responses:gpt",
				replacementHistory: [
					{
						type: "agent_message",
						author: "root",
						recipient: "root/child",
						content: [{ type: "input_text", text: 42 }],
					},
					{ type: "compaction", encrypted_content: "opaque" },
				],
			},
		},
		{ id: "tail", type: "message", message: { role: "user", content: [{ type: "text", text: "tail" }] } },
	] as never;
	const { handlers, ctx } = installExtension(branch);

	const result = handlers.get("context")?.(
		{ messages: [{ role: "compactionSummary", content: [{ type: "text", text: "OLD SUMMARY" }] }] },
		ctx,
	);

	expect(result).toEqual({
		messages: [
			{ role: "user", content: [{ type: "text", text: "old" }] },
			{ role: "user", content: [{ type: "text", text: "kept" }] },
			{ role: "user", content: [{ type: "text", text: "tail" }] },
		],
	});
});

test("clears turn state when navigating to another session-tree leaf", () => {
	const { handlers, ctx } = installExtension();
	handlers.get("after_provider_response")?.({ headers: { "x-codex-turn-state": "active" } }, ctx);
	const beforeTreeHeaders: Record<string, string | null> = {};
	handlers.get("before_provider_headers")?.({ headers: beforeTreeHeaders }, ctx);
	expect(beforeTreeHeaders["x-codex-turn-state"]).toBe("active");

	handlers.get("session_tree")?.({ newLeafId: "other", oldLeafId: "current" }, ctx);
	const afterTreeHeaders: Record<string, string | null> = {};
	handlers.get("before_provider_headers")?.({ headers: afterTreeHeaders }, ctx);
	expect(afterTreeHeaders["x-codex-turn-state"]).toBeUndefined();
});

test("reports a terminal request failure without interactive choices", async () => {
	const { handlers, ctx, notify } = installExtension([checkpointEntry()], true);

	await handlers.get("before_provider_request")?.({ payload: {} }, ctx);

	expect(notify).toHaveBeenCalledWith(
		expect.stringMatching(/^OpenAI Codex failure: phase=before_provider_request; code=[a-z0-9_.-]+; model=gpt; recoveryAttempted=false; outcome=request_aborted; next=.+$/),
		"error",
	);
	expect(ctx.abort).toHaveBeenCalled();
});

test("persists safe diagnostics without request input or raw error text", async () => {
	const secret = "sk-live-user-input-secret";
	const branch = [
		{
			id: "history-user",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "older history" }] },
		},
		checkpointEntry(),
		{
			id: "failed-user",
			parentId: "checkpoint",
			timestamp: new Date().toISOString(),
			type: "message",
			message: { role: "user", content: [{ type: "text", text: secret }] },
		},
	] as never;
	const { handlers, ctx, notify, appendEntry } = installExtension(branch, true);
	const fetchMock = vi.fn(async () => new Response(
		JSON.stringify({ error: { code: "credential_bearer_secret", message: "Authorization Bearer secret" } }),
		{ status: 400 },
	));
	vi.stubGlobal("fetch", fetchMock);
	try {
		await handlers.get("before_provider_request")?.({
			payload: { input: [{ role: "user", content: [{ type: "input_text", text: secret }] }] },
		}, ctx);
	} finally {
		vi.unstubAllGlobals();
	}

	const failed = appendEntry.mock.calls.find(([kind]) => kind === FAILED_REQUEST_KIND)?.[1] as Record<string, unknown> | undefined;
	expect(failed).toMatchObject({
		kind: FAILED_REQUEST_KIND,
		entryId: "failed-user",
		diagnostics: {
			phase: "before_provider_request",
			code: "http_400",
			recoveryAttempted: false,
		},
	});
	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(failed).not.toHaveProperty("content");
	expect(JSON.stringify(failed)).not.toContain(secret);
	expect(JSON.stringify(failed)).not.toContain("credential_bearer_secret");
	expect(JSON.stringify(failed)).not.toContain("Authorization Bearer secret");
	expect(notify).toHaveBeenCalledWith(expect.not.stringContaining(secret), "error");
	expect(notify).toHaveBeenCalledWith(expect.not.stringContaining("credential_bearer_secret"), "error");
});

test("writes the same safe failure notice without UI", async () => {
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const { handlers, ctx } = installExtension([checkpointEntry()]);
	await handlers.get("before_provider_request")?.({ payload: {} }, ctx);
	const calls = error.mock.calls;
	error.mockRestore();
	expect(calls).toHaveLength(1);
	expect(calls[0]).toEqual([
		expect.stringMatching(/^OpenAI Codex failure: phase=before_provider_request; code=[a-z0-9_.-]+; model=gpt; recoveryAttempted=false; outcome=request_aborted; next=.+$/),
	]);
});

test("reports a terminal manual compaction failure without choices", async () => {
	const { handlers, ctx, notify } = installExtension([], true);
	vi.stubGlobal("fetch", async () => new Response(
		JSON.stringify({ error: { code: "manual_failure", message: "do-not-display-this-body" } }),
		{ status: 400 },
	));
	try {
		await expect(handlers.get("session_before_compact")?.({
			branchEntries: [],
			preparation: { firstKeptEntryId: "", tokensBefore: 0 },
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		}, ctx)).resolves.toEqual({ cancel: true });
	} finally {
		vi.unstubAllGlobals();
	}
	expect(notify).toHaveBeenCalledWith(
		expect.stringMatching(/^OpenAI Codex failure: phase=session_before_compact; code=http_400; model=gpt; recoveryAttempted=false; outcome=compaction_cancelled; next=.+$/),
		"error",
	);
	expect(notify).toHaveBeenCalledWith(expect.not.stringContaining("do-not-display-this-body"), "error");
});

test("reports a safe manual compaction failure without UI", async () => {
	const error = vi.spyOn(console, "error").mockImplementation(() => {});
	const { handlers, ctx, notify } = installExtension([], false);
	vi.stubGlobal("fetch", async () => new Response(
		JSON.stringify({ error: { code: "credential_bearer_secret", message: "Authorization Bearer secret" } }),
		{ status: 400 },
	));
	try {
		await expect(handlers.get("session_before_compact")?.({
			branchEntries: [],
			preparation: { firstKeptEntryId: "", tokensBefore: 0 },
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		}, ctx)).resolves.toEqual({ cancel: true });
	} finally {
		vi.unstubAllGlobals();
	}
	const calls = error.mock.calls;
	error.mockRestore();
	expect(notify).not.toHaveBeenCalled();
	expect(calls).toHaveLength(1);
	expect(calls[0]).toEqual([
		expect.stringMatching(/^OpenAI Codex failure: phase=session_before_compact; code=http_400; model=gpt; recoveryAttempted=false; outcome=compaction_cancelled; next=.+$/),
	]);
	expect(String(calls[0]?.[0])).not.toContain("credential_bearer_secret");
	expect(String(calls[0]?.[0])).not.toContain("Authorization Bearer secret");
});

test("cancels a stale compaction after the session tree changes", async () => {
	const { handlers, ctx } = installExtension();
	let resolveFetch!: (response: Response) => void;
	let markFetchStarted!: () => void;
	const fetchStarted = new Promise<void>((resolve) => {
		markFetchStarted = resolve;
	});
	const fetchResponse = new Promise<Response>((resolve) => {
		resolveFetch = resolve;
	});
	vi.stubGlobal("fetch", async () => {
		markFetchStarted();
		return fetchResponse;
	});
	try {
		const compaction = handlers.get("session_before_compact")?.({
			branchEntries: [],
			preparation: { firstKeptEntryId: "", tokensBefore: 0 },
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		}, ctx);
		await fetchStarted;
		handlers.get("session_tree")?.({}, ctx);
		resolveFetch(new Response([
			'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque"}}',
			'data: {"type":"response.completed","response":{"id":"response"}}',
		].join("\n\n") + "\n\n", {
			headers: {
				"content-type": "text/event-stream",
				"x-codex-turn-state": "old-leaf-state",
			},
		}));
		await expect(compaction).resolves.toEqual({ cancel: true });
		const headers: Record<string, string | null> = {};
		handlers.get("before_provider_headers")?.({ headers }, ctx);
		expect(headers["x-codex-turn-state"]).toBeUndefined();
	} finally {
		vi.unstubAllGlobals();
	}
});

test("does not preserve an active failed user during manual compaction", async () => {
	const secret = "stale-failed-input";
	const branch = [
		{
			id: "failed-user",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "message",
			message: { role: "user", content: [{ type: "text", text: secret }] },
		},
		{
			id: "failed-marker",
			parentId: "failed-user",
			timestamp: new Date().toISOString(),
			type: "custom",
			customType: FAILED_REQUEST_KIND,
			data: { kind: FAILED_REQUEST_KIND, entryId: "failed-user" },
		},
	] as never;
	const { handlers, ctx } = installExtension(branch);
	vi.stubGlobal("fetch", async () => new Response([
		'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque"}}',
		'data: {"type":"response.completed","response":{"id":"response"}}',
	].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } }));
	try {
		const result = await handlers.get("session_before_compact")?.({
			branchEntries: branch,
			preparation: { firstKeptEntryId: "", tokensBefore: 0 },
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		}, ctx) as { compaction?: { details?: { replacementHistory?: unknown[]; preservedInput?: unknown[] } } } | undefined;
		const details = result?.compaction?.details;
		expect(details?.replacementHistory).not.toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "user", content: expect.arrayContaining([expect.objectContaining({ text: secret })]) }),
		]));
		expect(details?.preservedInput ?? []).not.toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "user", content: expect.arrayContaining([expect.objectContaining({ text: secret })]) }),
		]));
		expect(JSON.stringify(details)).not.toContain(secret);
	} finally {
		vi.unstubAllGlobals();
	}
});

test.each([
	["invalid_api_key", "check Codex authentication and retry manually"],
	["authentication_error", "check Codex authentication and retry manually"],
	["unauthorized", "check Codex authentication and retry manually"],
	["forbidden", "check Codex authentication and retry manually"],
	["permission_denied", "check Codex authentication and retry manually"],
	["invalid_token", "check Codex authentication and retry manually"],
	["credential_error", "check Codex authentication and retry manually"],
	["policy_violation", "check Codex plan, permissions, quota, and billing before retrying manually"],
	["insufficient_quota", "check Codex plan, permissions, quota, and billing before retrying manually"],
	["usage_limit_reached", "check Codex plan, permissions, quota, and billing before retrying manually"],
	["billing_error", "check Codex plan, permissions, quota, and billing before retrying manually"],
	["out_of_budget", "check Codex plan, permissions, quota, and billing before retrying manually"],
] as const)("uses a safe next step for $0", async (code, nextStep) => {
	const { handlers, ctx, notify } = installExtension([], true);
	vi.stubGlobal("fetch", async () => new Response(
		JSON.stringify({ error: { code, message: "safe test failure" } }),
		{ status: 400 },
	));
	try {
		await expect(handlers.get("session_before_compact")?.({
			branchEntries: [],
			preparation: { firstKeptEntryId: "", tokensBefore: 0 },
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		}, ctx)).resolves.toEqual({ cancel: true });
	} finally {
		vi.unstubAllGlobals();
	}
	const notice = notify.mock.calls.at(-1)?.[0];
	expect(notice).toContain(`code=${code}`);
	expect(notice).toContain(`next=${nextStep}.`);
});

test("reuses the last request settings and turn state for manual compaction", async () => {
	const { handlers, ctx, model } = installExtension();
	await handlers.get("before_provider_request")?.({
		payload: {
			model: model.id,
			input: [],
			instructions: "request instructions",
			reasoning: { effort: "xhigh", summary: "detailed" },
			service_tier: "priority",
			text: { verbosity: "high" },
		},
	}, ctx);

	let requestBody: Record<string, unknown> | undefined;
	vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
		requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response([
			'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque"}}',
			'data: {"type":"response.completed","response":{"id":"response"}}',
		].join("\n\n") + "\n\n", {
			headers: { "content-type": "text/event-stream", "x-codex-turn-state": "compact-state" },
		});
	});
	try {
		await handlers.get("session_before_compact")?.({
			branchEntries: [],
			preparation: { firstKeptEntryId: "", tokensBefore: 0 },
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		}, ctx);

		expect(requestBody).toMatchObject({
			instructions: "request instructions",
			reasoning: { effort: "xhigh", summary: "detailed" },
			service_tier: "priority",
			text: { verbosity: "high" },
		});
		const headers: Record<string, string | null> = {};
		handlers.get("before_provider_headers")?.({ headers }, ctx);
		expect(headers["x-codex-turn-state"]).toBe("compact-state");
		handlers.get("after_provider_response")?.({ headers: { "x-codex-turn-state": "later-state" } }, ctx);
		const stableHeaders: Record<string, string | null> = {};
		handlers.get("before_provider_headers")?.({ headers: stableHeaders }, ctx);
		expect(stableHeaders["x-codex-turn-state"]).toBe("compact-state");

		handlers.get("turn_end")?.({}, ctx);
		const nextHeaders: Record<string, string | null> = {};
		handlers.get("before_provider_headers")?.({ headers: nextHeaders }, ctx);
		expect(nextHeaders["x-codex-turn-state"]).toBeUndefined();
	} finally {
		vi.unstubAllGlobals();
	}
});

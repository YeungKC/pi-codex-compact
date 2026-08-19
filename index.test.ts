import { expect, test, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import codexCompactionExtension from "./index.ts";
import { NATIVE_COMPACTION_KIND } from "./native-compaction.ts";

type Handler = (event: any, ctx: any) => unknown;

const apiKey = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.c`;

function legacyEntry(): SessionEntry {
	return {
		id: "legacy",
		parentId: null,
		timestamp: new Date().toISOString(),
		type: "compaction",
		details: {
			kind: NATIVE_COMPACTION_KIND,
			version: 1,
			modelKey: "openai-codex:openai-codex-responses:gpt",
			replacementHistory: [{ type: "compaction", encrypted_content: "old" }],
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
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey,
				headers: {},
				baseUrl: "https://example.test/backend-api",
			}),
		},
	};
	codexCompactionExtension({
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		getAllTools: () => [],
		getActiveTools: () => [],
		appendEntry: vi.fn(),
	} as never);
	return { handlers, ctx, model, notify };
}

test("filters Pi compaction summaries before legacy checkpoint migration", () => {
	const { handlers, ctx } = installExtension([legacyEntry()]);

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

test("removes unsupported prompt cache retention from Codex requests", async () => {
	const { handlers, ctx, notify } = installExtension([], true);
	const result = await handlers.get("before_provider_request")?.({
		payload: {
			model: "gpt",
			input: [],
			prompt_cache_retention: "24h",
		},
	}, ctx);

	expect(result).toEqual({ model: "gpt", input: [] });
	expect(notify).toHaveBeenCalledWith(
		"OpenAI Codex does not support prompt_cache_retention; the setting was ignored.",
		"warning",
	);

	handlers.get("session_tree")?.({ newLeafId: "other", oldLeafId: "current" }, ctx);
	await handlers.get("before_provider_request")?.({
		payload: { model: "gpt", input: [], prompt_cache_retention: "24h" },
	}, ctx);
	expect(notify).toHaveBeenCalledTimes(1);
});

test("removes unsupported prompt cache retention even when request preparation aborts", async () => {
	const { handlers, ctx } = installExtension([legacyEntry()], true);
	const payload: Record<string, unknown> = { prompt_cache_retention: "24h" };

	await handlers.get("before_provider_request")?.({ payload }, ctx);

	expect(payload.prompt_cache_retention).toBeUndefined();
	expect(ctx.abort).toHaveBeenCalled();
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
			'data: {"type":"response.completed"}',
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

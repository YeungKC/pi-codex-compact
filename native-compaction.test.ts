import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("node:timers/promises", () => ({
	setTimeout: (ms: number, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
		const signal = options?.signal;
		if (signal?.aborted) return reject(signal.reason);
		const timer = globalThis.setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(value);
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	}),
}));

import { createNativeCheckpoint } from "./remote-compaction.ts";
import { approximateResponseItemTokens, isContextWindowCompactionError, isRetryableCompactionError, estimateCompactionWindowPrefillTokens, buildCodexHeaders, buildCompactionRequestBody, buildReplacementHistory, callRemoteCompaction, findNativeCheckpoint, fullInputForBranch, NATIVE_COMPACTION_KIND, NATIVE_COMPACTION_VERSION, parseNativeCompactionDetails, piContextInputForBranch, retainRecentMessages, latestRemoteCompactionSuffix, trimFunctionCallHistoryToFitContextWindow } from "./native-compaction.ts";

afterEach(() => vi.useRealTimers());

type RemoteRequest = Parameters<typeof callRemoteCompaction>[0];
const remoteModel = { id: "gpt", provider: "openai-codex", api: "openai-codex-responses" } as never;
const remoteRequest = (overrides: Partial<RemoteRequest> = {}): RemoteRequest => ({
	url: "https://example.test/compact",
	headers: new Headers(),
	body: {},
	model: remoteModel,
	...overrides,
});

const sseHeaders = { "content-type": "text/event-stream" };

function sse(data: string): Response {
	return new Response(data, { headers: sseHeaders });
}

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
	try {
		await operation;
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("Codex compaction history", () => {
	test("marks authentication failures fail-closed", async () => {
		await expect(createNativeCheckpoint({
			ctx: {
				modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "403" }) },
			} as never,
			model: { id: "gpt", provider: "openai-codex", api: "openai-codex-responses" } as never,
			input: [],
			allTools: [],
			activeToolNames: [],
		})).rejects.toMatchObject({ retryWithCurrentModel: false });
	});

	test("builds the Codex allowlisted request shape", () => {
		const body = buildCompactionRequestBody({
			basePayload: {
				instructions: "rewritten instructions",
				tools: [{ type: "custom_tool", name: "grammar_tool" }],
				tool_choice: { type: "custom" },
				temperature: 0,
			},
			model: { id: "gpt", provider: "openai-codex", api: "openai-codex-responses" } as never,
			input: [],
			instructions: "instructions",
			tools: [{ type: "function", name: "wrong-tool" }],
			sessionId: "session",
		});
		expect(body.instructions).toBe("rewritten instructions");
		expect(body.tools).toEqual([{ type: "custom_tool", name: "grammar_tool" }]);
		expect(body.tool_choice).toBe("auto");
		expect(body.temperature).toBeUndefined();
	});

	test("uses SSE and retains the V2 feature token", () => {
		const apiKey = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.c`;
		const headers = buildCodexHeaders({
			apiKey,
			headers: { "x-codex-beta-features": "other,remote_compaction_v2", "x-remove": null },
			sessionId: "session",
			turnState: "sticky",
		});
		expect(headers.get("accept")).toBe("text/event-stream");
		expect(headers.get("x-codex-beta-features")).toBe("other,remote_compaction_v2");
		expect(headers.get("x-codex-turn-state")).toBe("sticky");
		expect(headers.get("x-remove")).toBeNull();
	});

	test("reserves the stable prefix before sending remote compaction", async () => {
		let requestUrl: string | undefined;
		let requestBody: Record<string, unknown> | undefined;
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			requestUrl = url;
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response([
				'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque"}}',
				'data: {"type":"response.completed"}',
			].join("\n\n") + "\n\n", { headers: { "content-type": "text/event-stream" } });
		});
		try {
			await createNativeCheckpoint({
				ctx: {
					getSystemPrompt: () => "i".repeat(400),
					thinkingLevel: "high",
					modelRegistry: {
						getApiKeyAndHeaders: async () => ({
							ok: true,
							apiKey: `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } })).toString("base64url")}.c`,
							headers: {},
							baseUrl: "https://auth.example/backend-api",
						}),
					},
					sessionManager: { getSessionId: () => "session" },
				} as never,
				model: { id: "gpt", provider: "openai-codex", api: "openai-codex-responses", contextWindow: 160 } as never,
				input: [{ type: "function_call_output", call_id: "1", output: "x".repeat(400) }],
				allTools: [],
				activeToolNames: [],
			});
			expect(requestUrl).toBe("https://auth.example/backend-api/codex/responses");
			expect(requestBody?.reasoning).toEqual({ effort: "high", summary: "auto" });
			expect(requestBody?.input).toEqual(expect.arrayContaining([
				expect.objectContaining({ type: "compaction_trigger" }),
			]));
			const output = (requestBody?.input as Array<{ type?: string; output?: string }>).find((item) => item.type === "function_call_output");
			expect(output?.output?.length).toBeLessThan(400);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	test("preserves eligible response.failed details for model fallback", async () => {
		let calls = 0;
		const body = "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"context_length_exceeded\",\"message\":\"too large\"}}}\n\ndata: [DONE]\n\n";
		await expect(callRemoteCompaction(remoteRequest({
			fetchImpl: async () => {
				calls++;
				return sse(body);
			},
		}))).rejects.toThrow("context_length_exceeded");
		expect(calls).toBe(1);
	});
	test.each([
		{
			name: "missing-model HTTP 404",
			response: () => new Response(JSON.stringify({ error: { code: "model_not_found" } }), { status: 404 }),
			expectedFallback: true,
			expectedCalls: 1,
		},
		{
			name: "code-only context failure",
			response: () => sse("data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"invalid_prompt\"}}}\n\ndata: [DONE]\n\n"),
			expectedFallback: true,
			expectedCalls: 1,
		},
	])("allows $name to fall back", async ({ response, expectedFallback, expectedCalls }) => {
		let calls = 0;
		const failure = await callRemoteCompaction(remoteRequest({
			fetchImpl: async () => {
				calls++;
				return response();
			},
		})).catch(error => error);
		expect(failure).toMatchObject({ retryWithCurrentModel: expectedFallback });
		expect(calls).toBe(expectedCalls);
	});

	test("retries transient response.failed errors and preserves details", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const promise = callRemoteCompaction(remoteRequest({
			fetchImpl: async () => {
				calls++;
				return sse("data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"internal_server_error\",\"message\":\"busy\"}}}\n\ndata: [DONE]\n\n");
			},
		}));
		const failure = expect(promise).rejects.toMatchObject({ message: expect.stringContaining("busy"), retryWithCurrentModel: false });
		await vi.runAllTimersAsync();
		await failure;
		expect(calls).toBe(3);
	});

	test("uses the SSE retry-after hint", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const promise = callRemoteCompaction(remoteRequest({
			fetchImpl: async () => {
				calls++;
				return sse("data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"rate_limit_exceeded\",\"message\":\"try again in 5s\"}}}\n\ndata: [DONE]\n\n");
			},
		}));
		const failure = promise.catch(error => error);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(calls).toBe(1);
		await vi.runAllTimersAsync();
		expect(await failure).toMatchObject({ retryWithCurrentModel: false });
		expect(calls).toBe(3);
	});

	test.each([
		["content_filter", false, 3, false],
		["new_protocol_reason", false, 3, false],
		["server_error", false, 3, true],
	] as const)("handles incomplete reason %s", async (reason, expectedFallback, expectedCalls, expectedExplicitRetry) => {
		vi.useFakeTimers();
		let calls = 0;
		const promise = callRemoteCompaction(remoteRequest({
			fetchImpl: async () => {
				calls++;
				return sse(`data: ${JSON.stringify({ type: "response.incomplete", response: { incomplete_details: { reason } } })}\n\n`);
			},
		}));
		const failure = promise.catch(error => error);
		await vi.runAllTimersAsync();
		const error = await failure;
		expect(error).toMatchObject({ retryWithCurrentModel: expectedFallback });
		expect(isRetryableCompactionError(error)).toBe(expectedExplicitRetry);
		expect(calls).toBe(expectedCalls);
	});

	test("does not treat a protocol incomplete response as context overflow", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const failure = callRemoteCompaction(remoteRequest({
			fetchImpl: async () => {
				calls++;
				return sse('data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"new_protocol_reason","message":"context_length_exceeded"}}}\n\n');
			},
		})).catch((error) => error);
		await vi.runAllTimersAsync();
		const error = await failure;
		expect(calls).toBe(3);
		expect(isContextWindowCompactionError(error)).toBe(false);
		expect(isRetryableCompactionError(error)).toBe(false);
	});

	test("marks an incomplete context overflow for automatic retry only", async () => {
		vi.useFakeTimers();
		const failure = callRemoteCompaction(remoteRequest({
			fetchImpl: async () => sse('data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"context_length_exceeded"}}}\n\n'),
		})).catch((error) => error);
		await vi.runAllTimersAsync();
		const error = await failure;
		expect(isContextWindowCompactionError(error)).toBe(true);
		expect(isRetryableCompactionError(error)).toBe(false);
	});

	test("does not switch models for usage-limit SSE errors", async () => {
		let calls = 0;
		let failure: unknown;
		try {
			await callRemoteCompaction(remoteRequest({
				fetchImpl: async () => {
					calls++;
					return sse("data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"usage_limit_reached\",\"message\":\"try another model\"}}}\n\ndata: [DONE]\n\n");
				},
			}));
		} catch (error) {
			failure = error;
		}
		expect(calls).toBe(3);
		expect(failure).toMatchObject({ retryWithCurrentModel: false });
	});

	test("maps HTTP usage errors and transient overloads separately", async () => {
		vi.useFakeTimers();
		for (const [status, body, expectedCalls] of [
			[429, { error: { type: "usage_limit_reached", message: "try another model" } }, 1],
			[429, { error: { code: "rate_limit_reached", message: "slow down" } }, 3],
			[503, { error: { code: "server_is_overloaded", message: "busy" } }, 3],
		] as const) {
			let calls = 0;
			let failure: unknown;
			const promise = callRemoteCompaction(remoteRequest({
				fetchImpl: async () => {
					calls++;
					return new Response(JSON.stringify(body), { status });
				},
			}));
			const settled = promise.then(() => undefined, (error) => { failure = error; });
			await vi.runAllTimersAsync();
			await settled;
			expect(calls).toBe(expectedCalls);
			expect((failure as { retryWithCurrentModel?: boolean }).retryWithCurrentModel).toBe(true);
		}
	});

	test.each([
		{
			name: "unknown HTTP code",
			response: () => new Response(JSON.stringify({ error: { code: "future_protocol_code" } }), { status: 500 }),
			expectedFallback: true,
			expectedCalls: 3,
		},
		{
			name: "canceled HTTP error",
			response: () => new Response(JSON.stringify({ error: { code: "canceled" } }), { status: 400 }),
			expectedFallback: false,
			expectedCalls: 1,
		},
		{
			name: "message-only HTTP usage limit",
			response: () => new Response(JSON.stringify({ error: { message: "usage limit reached" } }), { status: 429 }),
			expectedFallback: true,
			expectedCalls: 1,
		},
		{
			name: "quota response.failed error",
			response: () => sse("data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"insufficient_quota\",\"message\":\"quota exceeded\"}}}\n\ndata: [DONE]\n\n"),
			expectedFallback: false,
			expectedCalls: 1,
		},
		{
			name: "policy response.failed error",
			response: () => sse("data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"invalid_prompt\",\"message\":\"policy violation\"}}}\n\ndata: [DONE]\n\n"),
			expectedFallback: false,
			expectedCalls: 1,
		},
		{
			name: "machine-readable SSE error",
			response: () => sse("data: {\"type\":\"error\",\"code\":\"invalid_api_key\",\"message\":\"invalid request\"}\n\ndata: [DONE]\n\n"),
			expectedFallback: false,
			expectedCalls: 1,
		},
		{
			name: "malformed SSE data",
			response: () => sse("data: {bad\n\n"),
			expectedFallback: false,
			expectedCalls: 3,
		},
		{
			name: "non-object SSE data",
			response: () => sse("data: null\n\n"),
			expectedFallback: false,
			expectedCalls: 3,
		},
		{
			name: "unknown SSE message-only error",
			response: () => sse('data: {"type":"future.error","message":"unknown"}\n\n'),
			expectedFallback: false,
			expectedCalls: 3,
		},
		{
			name: "unknown SSE error event",
			response: () => sse('data: {"type":"future.error","code":"future_protocol_code","message":"unknown"}\n\n'),
			expectedFallback: false,
			expectedCalls: 3,
		},
		{
			name: "unknown SSE code",
			response: () => sse('data: {"type":"error","code":"new_protocol_code","message":"invalid request"}\n\n'),
			expectedFallback: false,
			expectedCalls: 3,
		},
	])("handles $name", async ({ response, expectedFallback, expectedCalls }) => {
		vi.useFakeTimers();
		let calls = 0;
		const promise = callRemoteCompaction(remoteRequest({
			fetchImpl: async () => {
				calls++;
				return response();
			},
		}));
		const failure = promise.catch(error => error);
		await vi.runAllTimersAsync();
		expect(await failure).toMatchObject({ retryWithCurrentModel: expectedFallback });
		expect(calls).toBe(expectedCalls);
	});

	test("preserves nested SSE error details", async () => {
		let calls = 0;
		const failure = await captureFailure(callRemoteCompaction(remoteRequest({
			fetchImpl: async () => {
				calls++;
				return sse("data: {\"type\":\"error\",\"error\":{\"code\":\"invalid_prompt\",\"message\":\"nested invalid prompt\"}}\n\ndata: [DONE]\n\n");
			},
		})));
		expect(failure).toMatchObject({ message: "OpenAI Codex compaction failed (invalid_prompt): nested invalid prompt", retryWithCurrentModel: true });
		expect(calls).toBe(1);
	});

	test("returns after a completed SSE event without waiting for EOF", async () => {
		let cancelled = false;
		const result = await callRemoteCompaction(remoteRequest({
			fetchImpl: async () => {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode([
							'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque"}}',
							'data: {"type":"response.completed"}',
						].join("\n\n") + "\n\n"));
					},
					cancel() {
						cancelled = true;
					},
				});
				return new Response(stream, { headers: { "content-type": "text/event-stream" } });
			},
		}));
		expect(result.compactionItem).toMatchObject({ type: "compaction", encrypted_content: "opaque" });
		expect(cancelled).toBe(true);
	});

	test("cancels an open SSE reader when the compaction is aborted", async () => {
		const controller = new AbortController();
		let started!: () => void;
		let cancelled = false;
		const streamStarted = new Promise<void>((resolve) => { started = resolve; });
		const pending = callRemoteCompaction(remoteRequest({
			signal: controller.signal,
			fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
				start() {
					started();
				},
				cancel() {
					cancelled = true;
				},
			}), { headers: { "content-type": "text/event-stream" } }),
		}));
		await streamStarted;
		controller.abort();
		const outcome = await Promise.race([
			pending.then(
				() => ({ state: "resolved" as const }),
				error => ({ state: "rejected" as const, error }),
			),
			new Promise<{ state: "timeout" }>((resolve) => setTimeout(() => resolve({ state: "timeout" }), 100)),
		]);
		expect(outcome).toMatchObject({ state: "rejected", error: { retryWithCurrentModel: false } });
		expect(cancelled).toBe(true);
	});

	test("counts opaque reasoning and compaction payloads", () => {
		const opaque = "x".repeat(4_000);
		expect(approximateResponseItemTokens([{ type: "reasoning", encrypted_content: opaque }])).toBeGreaterThan(500);
		expect(approximateResponseItemTokens([{ type: "compaction", encrypted_content: opaque }])).toBeGreaterThan(500);
	});

	test("counts function-call metadata in approximate token accounting", () => {
		const tokens = approximateResponseItemTokens([{ type: "function_call", name: "a-very-long-tool-name", call_id: "call-123456789", arguments: "{}" } as never]);
		expect(tokens).toBeGreaterThan(1);
	});

	test("uses the first assistant usage after the current compaction window as its baseline", () => {
		const branch = [
			{ id: "before", type: "message", message: { role: "assistant", usage: { input: 900, cacheRead: 0, cacheWrite: 0, totalTokens: 950 } } },
			{ id: "checkpoint", type: "custom", customType: NATIVE_COMPACTION_KIND, data: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				strategy: "v2",
				modelKey: "openai-codex:openai-codex-responses:gpt",
				replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
			} },
			{ id: "other-provider", type: "message", message: {
				role: "assistant",
				provider: "anthropic",
				api: "anthropic-messages",
				stopReason: "stop",
				usage: { input: 900, cacheRead: 0, cacheWrite: 0, totalTokens: 950 },
			} },
			{ id: "after", type: "message", message: {
				role: "assistant",
				provider: "openai-codex",
				api: "openai-codex-responses",
				stopReason: "stop",
				usage: { input: 100, cacheRead: 20, cacheWrite: 5, totalTokens: 150 },
			} },
		] as never;

		expect(estimateCompactionWindowPrefillTokens({ branch, stablePrefixTokens: 10 })).toBe(125);
	});

	test("leaves the body-after-prefix baseline unset before the first usage", () => {
		expect(estimateCompactionWindowPrefillTokens({
			branch: [{ id: "user", type: "message", message: { role: "user", content: "hello" } }] as never,
			stablePrefixTokens: 10,
		})).toBeUndefined();
	});

	test("estimates a new baseline from replacement history after compaction", () => {
		const branch = [{ id: "checkpoint", type: "custom", customType: NATIVE_COMPACTION_KIND, data: {
			kind: NATIVE_COMPACTION_KIND,
			version: NATIVE_COMPACTION_VERSION,
			strategy: "v2",
			modelKey: "openai-codex:openai-codex-responses:gpt",
			replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
	} }] as never;

		expect(estimateCompactionWindowPrefillTokens({ branch, stablePrefixTokens: 10 })).toBeGreaterThan(10);
	});

	test("keeps an unstructured HTTP 400 fail-closed", async () => {
		const failure = await captureFailure(callRemoteCompaction(remoteRequest({
			fetchImpl: async () => new Response("bad request details", { status: 400 }),
		})));
		expect(failure).toMatchObject({ retryWithCurrentModel: false });
	});

	test("keeps generic HTTP 403 out of model fallback", async () => {
		const failure = await captureFailure(callRemoteCompaction(remoteRequest({
			fetchImpl: async () => new Response("", { status: 403 }),
		})));
		expect(failure).toMatchObject({ retryWithCurrentModel: false });
	});

	test("uses the preceding real compaction boundary after a custom checkpoint", () => {
		const branch = [
			{ id: "old", type: "message", message: { role: "user", content: "old" } },
			{ id: "kept", type: "message", message: { role: "user", content: "kept" } },
			{ id: "real-compaction", type: "compaction", firstKeptEntryId: "kept", summary: "summary", details: {} },
			{ id: "custom", type: "custom", customType: NATIVE_COMPACTION_KIND, data: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				strategy: "v2",
				modelKey: "openai-codex:openai-codex-responses:gpt",
				replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
			} },
			{ id: "tail", type: "message", message: { role: "user", content: "tail" } },
		] as never;
		const result = piContextInputForBranch({
			branch,
			model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt", reasoning: true } as never,
			tools: [],
		});
		expect(JSON.stringify(result)).toContain("kept");
		expect(JSON.stringify(result)).toContain("tail");
		expect(JSON.stringify(result)).not.toContain("old");
	});

	test("keeps Pi's compaction summary before retained entries", () => {
		const branch = [
			{ id: "old", type: "message", message: { role: "user", content: "old" } },
			{ id: "kept", type: "message", message: { role: "user", content: "kept" } },
			{ id: "real-compaction", type: "compaction", firstKeptEntryId: "kept", summary: "summary", details: {} },
			{ id: "tail", type: "message", message: { role: "user", content: "tail" } },
		] as never;
		const result = piContextInputForBranch({
			branch,
			model: { provider: "openai-codex", api: "openai-codex-responses", id: "gpt", reasoning: true } as never,
			tools: [],
		});
		const encoded = JSON.stringify(result);
		expect(encoded.indexOf("summary")).toBeLessThan(encoded.indexOf("kept"));
	});

	test("matches Pi message indexes across empty user entries", () => {
		const model = { provider: "openai-codex", api: "openai-codex-responses", id: "current", reasoning: true } as never;
		const branch = [
			{
				id: "tool-call",
				parentId: null,
				timestamp: new Date().toISOString(),
				type: "message",
				message: {
					role: "assistant",
					provider: "openai-codex",
					api: "openai-codex-responses",
					model: "previous",
					content: [{ type: "toolCall", id: "call|fc_old", name: "bash", arguments: {} }],
				},
			} as never,
			{
				id: "empty-user",
				parentId: null,
				timestamp: new Date().toISOString(),
				type: "message",
				message: { role: "user", content: [] },
			} as never,
			{
				id: "visible",
				parentId: null,
				timestamp: new Date().toISOString(),
				type: "message",
				message: {
					role: "assistant",
					provider: "openai-codex",
					api: "openai-codex-responses",
					model: "previous",
					content: [{ type: "text", text: "visible" }],
				},
			} as never,
		];
		const result = fullInputForBranch({ branch, model, tools: [] });
		expect(result.at(-1)).toMatchObject({ id: "msg_pi_2" });
	});
	test("keeps recent message items and drops tool history", () => {
		const result = retainRecentMessages([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "old" }] },
			{ type: "function_call", name: "shell", arguments: "{}" },
			{ type: "function_call_output", call_id: "1", output: "secret" },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
		]);

		expect(result.map((item) => item.role ?? item.type)).toEqual(["user"]);
	});

	test("drops developer and system messages by default", () => {
		const result = retainRecentMessages([
			{ type: "message", role: "developer", content: [{ type: "input_text", text: "developer" }] },
			{ type: "message", role: "system", content: [{ type: "input_text", text: "system" }] },
		]);
		expect(result).toEqual([]);
	});

	test("keeps an attached image resize notice with its retained source", () => {
		const userImage = { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,x" }] };
		const userNotice = {
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: "\n<image_resize_notice>\nImage 1 of 1 in the preceding user message was resized.\n</image_resize_notice>\n" }],
		};
		const toolNotice = {
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: "\n<image_resize_notice>\nImage 1 of 1 in the preceding tool output was resized.\n</image_resize_notice>\n" }],
		};
		const result = retainRecentMessages([
			userImage,
			userNotice,
			{ type: "message", role: "developer", content: [{ type: "input_text", text: "unlisted notice" }] },
			{ type: "function_call_output", call_id: "tool", output: "tool output" },
			toolNotice,
		]);
		expect(result).toEqual([userImage, userNotice]);
	});

	test("retains eligible agent messages within the per-item limit", () => {
		const result = retainRecentMessages([
			{ type: "agent_message", content: [{ type: "input_text", text: "Message Type: COMMENTARY\nsmall" }] },
		]);
		expect(result).toHaveLength(1);
	});

	test("drops oversized and final-answer agent messages", () => {
		const result = retainRecentMessages([
			{ type: "agent_message", author: "a", recipient: "b", content: [{ type: "input_text", text: `Message Type: COMMENTARY\n${"x".repeat(40_000)}` }] },
			{ type: "agent_message", author: "a", recipient: "b", content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\ndone" }] },
		]);
		expect(result).toEqual([]);
	});

	test("drops descendant progress agent messages even when they are small", () => {
		const result = retainRecentMessages([
			{ type: "agent_message", author: "root/child", recipient: "root", content: [{ type: "input_text", text: "Message Type: MESSAGE\nprogress" }] },
		]);
		expect(result).toEqual([]);
	});

	test("accepts the wire-shaped AgentMessage in a current checkpoint", () => {
		const details = parseNativeCompactionDetails({
			kind: NATIVE_COMPACTION_KIND,
			version: NATIVE_COMPACTION_VERSION,
			strategy: "v2",
			modelKey: "openai-codex:openai-codex-responses:test",
			replacementHistory: [
				{
					type: "agent_message",
					author: "root",
					recipient: "root/child",
					content: [{ type: "input_text", text: "Message Type: COMMENTARY\\nkeep" }],
				},
				{ type: "compaction", encrypted_content: "opaque" },
			],
		});
		expect(details?.replacementHistory).toHaveLength(2);
	});

	test("does not share the agent-message limit across items", () => {
		const result = retainRecentMessages([
			{ type: "agent_message", content: [{ type: "input_text", text: "x".repeat(24_000) }] },
			{ type: "agent_message", content: [{ type: "input_text", text: "y".repeat(24_000) }] },
		]);
		expect(result).toHaveLength(2);
	});

	test("retains image-only user messages", () => {
		const result = retainRecentMessages([
			{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,x" }] },
		]);
		expect(result).toHaveLength(1);
	});

	test("keeps retained images outside Codex's text budget", () => {
		expect(approximateResponseItemTokens([{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,x" }] }])).toBeGreaterThanOrEqual(1_200);
		expect(approximateResponseItemTokens([{ type: "function_call_output", output: [{ type: "input_image" }, { type: "input_image" }] }])).toBeGreaterThanOrEqual(2_400);
		expect(approximateResponseItemTokens([{ type: "function_call_output", output: [{ type: "input_image", image_url: `data:image/png;base64,${"x".repeat(40_000)}` }] }])).toBeLessThan(2_000);
		expect(retainRecentMessages([{ type: "message", role: "user", content: [{ type: "input_image" }] }], 1_199)).toEqual([
			{ type: "message", role: "user", content: [{ type: "input_image" }] },
		]);
		expect(retainRecentMessages([
			{ type: "message", role: "user", content: [{ type: "input_image", image_url: "old" }] },
			{ type: "message", role: "user", content: [{ type: "input_image", image_url: "new" }] },
		], 1)).toEqual([
			{ type: "message", role: "user", content: [{ type: "input_image", image_url: "new" }] },
		]);
	});

	test("truncates an oversized message without throwing", () => {
		const result = retainRecentMessages([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "abcdefghij" }] },
		], 1);
		expect(result[0]?.content).toEqual([{ type: "input_text", text: "abcd" }]);
	});

	test("replaces an oversized function output with Codex's marker", () => {
		const result = trimFunctionCallHistoryToFitContextWindow([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
			{ type: "function_call_output", call_id: "1", output: "1234567890" },
		], 2);
		expect(result[1]?.output).toBe("Output exceeded the available model context and was truncated");
	});

	test("keeps Codex's marker when the remaining budget is tiny", () => {
		const result = trimFunctionCallHistoryToFitContextWindow([
			{ type: "function_call_output", call_id: "1", output: "1234567890" },
		], 4, 2);
		expect(result[0]?.output).toBe("Output exceeded the available model context and was truncated");
	});

	test("rewrites oversized output before its attached image resize notice", () => {
		const notice = {
			type: "message",
			role: "developer",
			content: [{
				type: "input_text",
				text: "<image_resize_notice>tool output resized</image_resize_notice>",
			}],
		};
		const result = trimFunctionCallHistoryToFitContextWindow([
			{ type: "function_call_output", call_id: "call", output: "x".repeat(1_000) },
			notice,
		], 10);

		expect(result[0]?.output).toBe("Output exceeded the available model context and was truncated");
		expect(result[1]).toEqual(notice);
	});

	test("replaces image-bearing function output with Codex's truncation marker", () => {
		const result = trimFunctionCallHistoryToFitContextWindow([
			{ type: "function_call_output", output: [{ type: "input_image", image_url: "data:image/png;base64,large" }] },
		], 100);
		expect(result[0]?.output).toBe("Output exceeded the available model context and was truncated");
	});

	test("limits suffix recovery to context-window errors", () => {
		expect(isContextWindowCompactionError(new Error("context_length_exceeded"))).toBe(true);
		expect(isContextWindowCompactionError(new Error("policy violation in context window"))).toBe(false);
		expect(isContextWindowCompactionError(new Error("invalid_prompt: context window"))).toBe(false);
		expect(isContextWindowCompactionError(new Error("context window exceeded"))).toBe(false);
		const policyError = new Error("policy violation");
		Object.defineProperty(policyError, "compactionCode", { value: "context_length_exceeded" });
		expect(isContextWindowCompactionError(policyError)).toBe(false);
		expect(isContextWindowCompactionError(new Error("auth failure context_length_exceeded"))).toBe(false);
		expect(isContextWindowCompactionError(new Error("policy denied context_length_exceeded"))).toBe(false);
		const invalidPromptError = new Error("invalid_prompt: context_length_exceeded");
		Object.defineProperty(invalidPromptError, "compactionCode", { value: "context_length_exceeded" });
		expect(isContextWindowCompactionError(invalidPromptError)).toBe(false);
	});

	test("keeps the newest complete user turn for overflow recovery", () => {
		const result = latestRemoteCompactionSuffix([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "old" }] },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "old answer" }] },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "new" }] },
			{ type: "function_call", call_id: "call", name: "shell", arguments: "{}" },
			{ type: "function_call_output", call_id: "call", output: "new result" },
		], 1_000);

		expect(result).toEqual([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "new" }] },
			{ type: "function_call", call_id: "call", name: "shell", arguments: "{}" },
			{ type: "function_call_output", call_id: "call", output: "new result" },
		]);
	});

	test("trims the newest function output first", () => {
		const result = trimFunctionCallHistoryToFitContextWindow([
			{ type: "function_call_output", call_id: "old", output: "old".repeat(20) },
			{ type: "function_call_output", call_id: "new", output: "new".repeat(200) },
		], 120);
		expect(result[0]?.output).toBe("old".repeat(20));
		expect(result[1]?.output).toBe("Output exceeded the available model context and was truncated");
	});

	test("keeps machine-readable auth and policy errors out of model fallback", async () => {
		for (const body of ['{"code":"invalid_api_key"}', '{"code":"policy_violation"}']) {
			const failure = await captureFailure(callRemoteCompaction(remoteRequest({
				fetchImpl: async () => new Response(body, { status: 400 }),
			})));
			expect(failure).toMatchObject({ retryWithCurrentModel: false });
			expect(isRetryableCompactionError(failure)).toBe(false);
		}
	});

	test("marks exhausted transient errors as retryable for an explicit retry", async () => {
		const failure = await captureFailure(callRemoteCompaction(remoteRequest({
			fetchImpl: async () => new Response("temporary", {
				status: 503,
				headers: { "retry-after-ms": "0" },
			}),
		})));
		expect(isRetryableCompactionError(failure)).toBe(true);
	});

	test("always appends exactly one valid compaction checkpoint", () => {
		const result = buildReplacementHistory(
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "keep" }] }],
			{ type: "compaction", encrypted_content: "opaque" },
		);

		expect(result.at(-1)).toEqual({ type: "compaction", encrypted_content: "opaque" });
	});

	test("rejects a non-V2 checkpoint strategy", () => {
		expect(parseNativeCompactionDetails({
			kind: "openai-codex-native-compaction",
			version: NATIVE_COMPACTION_VERSION,
			strategy: "v1",
			modelKey: "openai-codex:openai-codex-responses:test",
			replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
		})).toBeUndefined();
	});

	test("rejects a non-native checkpoint", () => {
		expect(() => buildReplacementHistory([], { type: "message", role: "assistant", content: [] })).toThrow();
	});

	test("accepts a persisted compaction hash", () => {
		expect(parseNativeCompactionDetails({
			kind: "openai-codex-native-compaction",
			version: NATIVE_COMPACTION_VERSION,
			modelKey: "openai-codex:openai-codex-responses:test",
			compHash: "3000",
			replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
		})?.compHash).toBe("3000");
	});

	test("ignores a version-one checkpoint", () => {
		expect(findNativeCheckpoint([{
			id: "v1",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "custom",
			customType: NATIVE_COMPACTION_KIND,
			data: {
				kind: NATIVE_COMPACTION_KIND,
				version: 1,
				strategy: "v2",
				modelKey: "openai-codex:openai-codex-responses:test",
				replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
			},
		}] as never).status).toBe("none");
	});

	test("ignores the removed local token-budget checkpoint", () => {
		expect(findNativeCheckpoint([{
			id: "local",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "custom",
			customType: NATIVE_COMPACTION_KIND,
			data: {
				kind: NATIVE_COMPACTION_KIND,
				version: 1,
				strategy: "token-budget",
				modelKey: "openai-codex:openai-codex-responses:test",
				replacementHistory: [],
			},
		}] as never).status).toBe("none");
	});

	test("rejects the removed token-budget strategy in a current checkpoint", () => {
		expect(parseNativeCompactionDetails({
			kind: "openai-codex-native-compaction",
			version: NATIVE_COMPACTION_VERSION,
			strategy: "token-budget",
			modelKey: "openai-codex:openai-codex-responses:test",
			replacementHistory: [],
		})).toBeUndefined();
	});
});

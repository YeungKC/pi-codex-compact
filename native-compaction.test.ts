import { describe, expect, test } from "bun:test";
import { buildLegacyCompactionRequestBody, buildReplacementHistory, filterLegacyCompactionHistory, parseNativeCompactionDetails, retainRecentMessages, trimFunctionCallHistoryToFitContextWindow } from "./native-compaction.ts";

describe("Codex compaction history", () => {
	test("keeps recent message items and drops tool history", () => {
		const result = retainRecentMessages([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "old" }] },
			{ type: "function_call", name: "shell", arguments: "{}" },
			{ type: "function_call_output", call_id: "1", output: "secret" },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
		]);

		expect(result.map((item) => item.role ?? item.type)).toEqual(["user"]);
	});

	test("retains eligible agent messages within the per-item limit", () => {
		const result = retainRecentMessages([
			{ type: "agent_message", content: [{ type: "input_text", text: "Message Type: COMMENTARY\nsmall" }] },
		]);
		expect(result).toHaveLength(1);
	});

	test("drops oversized and final-answer agent messages", () => {
		const result = retainRecentMessages([
			{ type: "agent_message", content: [{ type: "input_text", text: `Message Type: COMMENTARY\n${"x".repeat(40_000)}` }] },
			{ type: "agent_message", content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\ndone" }] },
		]);
		expect(result).toEqual([]);
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

	test("truncates an oversized message without throwing", () => {
		const result = retainRecentMessages([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "abcdefghij" }] },
		], 1);
		expect(result[0]?.content).toEqual([{ type: "input_text", text: "abcd" }]);
	});

	test("trims old function output to the request budget", () => {
		const result = trimFunctionCallHistoryToFitContextWindow([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
			{ type: "function_call_output", call_id: "1", output: "1234567890" },
		], 2);
		expect(result[1]?.output).toBe("1234567890".slice(0, 4));
	});

	test("filters V1 tool history before replay", () => {
		const result = filterLegacyCompactionHistory([
			{ type: "message", role: "user", content: [] },
			{ type: "function_call", name: "shell" },
			{ type: "message", role: "assistant", content: [] },
		]);
		expect(result).toHaveLength(2);
	});

	test("drops contextual V1 user wrappers but keeps real user messages", () => {
		const result = filterLegacyCompactionHistory([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>old</environment_context>" }] },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "keep this" }] },
			{ type: "message", role: "developer", content: [{ type: "input_text", text: "stale instructions" }] },
		]);
		expect(result).toHaveLength(1);
		expect(result[0]?.content).toEqual([{ type: "input_text", text: "keep this" }]);
	});

	test("keeps valid V1 hook prompts", () => {
		const result = filterLegacyCompactionHistory([
			{ type: "message", role: "user", content: [{ type: "input_text", text: '<hook_prompt hook_run_id="run">retry</hook_prompt>' }] },
		]);
		expect(result).toHaveLength(1);
	});

	test("keeps hook prompts mixed with contextual fragments", () => {
		const result = filterLegacyCompactionHistory([
			{ type: "message", role: "user", content: [
				{ type: "input_text", text: "<environment_context>old</environment_context>" },
				{ type: "input_text", text: '<hook_prompt hook_run_id="run">retry</hook_prompt>' },
			] },
		]);
		expect(result).toHaveLength(1);
	});

	test("drops hook prompts mixed with ordinary user text", () => {
		const result = filterLegacyCompactionHistory([
			{ type: "message", role: "user", content: [
				{ type: "input_text", text: '<hook_prompt hook_run_id="run">retry</hook_prompt>' },
				{ type: "input_text", text: "ordinary text" },
			] },
		]);
		expect(result).toHaveLength(0);
	});

	test("recognizes common Codex wrappers without hiding literal user text", () => {
		const result = filterLegacyCompactionHistory([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>old</INSTRUCTIONS>" }] },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "<skill>old</skill>" }] },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>literal" }] },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "<external_a>literal</external_b>" }] },
			{ type: "message", role: "user", content: [{ type: "input_text", text: '<codex_internal_context source="Bad!">literal</codex_internal_context>' }] },
		]);
		expect(result).toHaveLength(3);
		expect(result.map((item) => item.content)).toEqual([
			[{ type: "input_text", text: "<environment_context>literal" }],
			[{ type: "input_text", text: "<external_a>literal</external_b>" }],
			[{ type: "input_text", text: '<codex_internal_context source="Bad!">literal</codex_internal_context>' }],
		]);
	});

	test("always appends exactly one valid compaction checkpoint", () => {
		const result = buildReplacementHistory(
			[{ type: "message", role: "user", content: [{ type: "input_text", text: "keep" }] }],
			{ type: "compaction", encrypted_content: "opaque" },
		);

		expect(result.at(-1)).toEqual({ type: "compaction", encrypted_content: "opaque" });
	});

	test("accepts an empty V1 replacement history", () => {
		const details = parseNativeCompactionDetails({
			kind: "openai-codex-native-compaction",
			version: 1,
			strategy: "v1",
			modelKey: "openai-codex:openai-codex-responses:test",
			replacementHistory: [],
		});
		expect(details?.strategy).toBe("v1");
	});

	test("accepts a V1 replacement history without an opaque item", () => {
		const details = parseNativeCompactionDetails({
			kind: "openai-codex-native-compaction",
			version: 1,
			strategy: "v1",
			modelKey: "openai-codex:openai-codex-responses:test",
			replacementHistory: [{ type: "message", role: "user", content: [{ type: "input_text", text: "summary" }] }],
		});
		expect(details?.strategy).toBe("v1");
	});

	test("V1 requests do not contain V2 trigger or streaming fields", () => {
		const body = buildLegacyCompactionRequestBody({
			model: { id: "test" } as never,
			input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }],
			instructions: "instructions",
			sessionId: "session",
		});
		expect(body.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }]);
		expect(body.stream).toBeUndefined();
		expect(body.store).toBeUndefined();
	});

	test("rejects a non-native checkpoint", () => {
		expect(() => buildReplacementHistory([], { type: "message", role: "assistant", content: [] })).toThrow();
	});

	test("accepts a persisted compaction hash", () => {
		expect(parseNativeCompactionDetails({
			kind: "openai-codex-native-compaction",
			version: 1,
			modelKey: "openai-codex:openai-codex-responses:test",
			compHash: "3000",
			replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
		})?.compHash).toBe("3000");
	});

	test("accepts a legacy checkpoint without strategy", () => {
		expect(parseNativeCompactionDetails({
			kind: "openai-codex-native-compaction",
			version: 1,
			modelKey: "openai-codex:openai-codex-responses:test",
			replacementHistory: [{ type: "compaction", encrypted_content: "opaque" }],
		})?.strategy).toBe("v2");
	});

	test("rejects an unknown persisted strategy", () => {
		expect(parseNativeCompactionDetails({
			kind: "openai-codex-native-compaction",
			version: 1,
			strategy: "future",
			modelKey: "openai-codex:openai-codex-responses:test",
			replacementHistory: [],
		})).toBeUndefined();
	});
});

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

		expect(result.map((item) => item.role ?? item.type)).toEqual(["user", "assistant"]);
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

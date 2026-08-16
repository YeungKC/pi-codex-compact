import { describe, expect, test } from "bun:test";
import { compactionCapability } from "./capabilities.ts";

const model = (provider: string) => ({ provider }) as never;

describe("Codex compaction capability routing", () => {
	test("routes the built-in OpenAI provider to V2 by default", () => {
		expect(compactionCapability(model("openai-codex"), { remoteCompactionV2: true, tokenBudget: false })).toBe("v2");
	});

	test("uses V1 when the V2 feature is disabled", () => {
		expect(compactionCapability(model("openai-codex"), { remoteCompactionV2: false, tokenBudget: false })).toBe("v1");
	});

	test("gives token budget precedence", () => {
		expect(compactionCapability(model("openai-codex"), { remoteCompactionV2: true, tokenBudget: true })).toBe("token-budget");
	});

	test("routes other providers to local compaction", () => {
		expect(compactionCapability(model("anthropic"), { remoteCompactionV2: true, tokenBudget: false })).toBe("local");
	});
});

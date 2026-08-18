import { describe, expect, test } from "vitest";
import { compactionCapability, compactionHash } from "./capabilities.ts";

const model = (provider: string, api = "openai-codex-responses", id = "gpt-5.5") => ({ provider, api, id }) as never;

describe("Codex compaction capability routing", () => {
	test("routes the built-in OpenAI Responses provider to V2 by default", () => {
		expect(compactionCapability(model("openai-codex"), { remoteCompactionV2: true, autoCompactScope: "total" })).toBe("v2");
	});

	test("uses V1 when the V2 feature is disabled", () => {
		expect(compactionCapability(model("openai-codex"), { remoteCompactionV2: false, autoCompactScope: "total" })).toBe("v1");
	});

	test("routes other APIs and providers to local compaction", () => {
		expect(compactionCapability(model("openai-codex", "openai-completions"), { remoteCompactionV2: true, autoCompactScope: "total" })).toBe("local");
		expect(compactionCapability(model("anthropic", "anthropic-messages"), { remoteCompactionV2: true, autoCompactScope: "total" })).toBe("local");
	});

	test("uses only the frozen Codex hash snapshot", () => {
		expect(compactionHash(model("openai-codex", "openai-codex-responses", "gpt-5.6-luna"))).toBe("3000");
		expect(compactionHash(model("openai-codex", "openai-codex-responses", "gpt-5.2"))).toBeUndefined();
		expect(compactionHash({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.4", compHash: "runtime" } as never)).toBe("2911");
		expect(compactionHash({ provider: "anthropic", api: "openai-codex-responses", id: "gpt-5.5" } as never)).toBeUndefined();
	});
});

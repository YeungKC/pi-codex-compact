import { describe, expect, test } from "vitest";
import { compactionCapability, compactionHash } from "./capabilities.ts";

const model = (provider: string) => ({ provider }) as never;

describe("Codex compaction capability routing", () => {
	test("routes the built-in OpenAI provider to V2 by default", () => {
		expect(compactionCapability(model("openai-codex"), { remoteCompactionV2: true, autoCompactScope: "total" })).toBe("v2");
	});

	test("uses V1 when the V2 feature is disabled", () => {
		expect(compactionCapability(model("openai-codex"), { remoteCompactionV2: false, autoCompactScope: "total" })).toBe("v1");
	});

	test("routes other providers to local compaction", () => {
		expect(compactionCapability(model("anthropic"), { remoteCompactionV2: true, autoCompactScope: "total" })).toBe("local");
	});

	test("uses Codex static compaction hashes and leaves unknown models unset", () => {
		expect(compactionHash({ id: "gpt-5.6-luna" } as never)).toBe("3000");
		expect(compactionHash({ id: "gpt-5.2" } as never)).toBeUndefined();
		expect(compactionHash({ id: "custom", compHash: "from-model" } as never)).toBe("from-model");
		expect(compactionHash({ id: "gpt-5.4", compHash: "runtime" } as never)).toBe("runtime");
	});
});

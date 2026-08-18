import { describe, expect, test } from "vitest";
import { shouldAutoCompact } from "./scheduler.ts";

const cases = [
	["configured total scope", { activeContextTokens: 100, contextWindow: 200 }, 100, "total", true],
	["body-after-prefix baseline", { activeContextTokens: 150, prefillTokens: 100, contextWindow: 200 }, 49, "bodyAfterPrefix", true],
	["body-after-prefix ignores total", { activeContextTokens: 850, prefillTokens: 200, contextWindow: 1_000 }, 700, "bodyAfterPrefix", false],
	["missing prefix baseline starts at zero", { activeContextTokens: 100, contextWindow: 200 }, 99, "bodyAfterPrefix", false],
	["omitted limit uses 90 percent", { activeContextTokens: 180, contextWindow: 200 }, undefined, "total", true],
	["body-after-prefix counts prefix once", { activeContextTokens: 1_050, prefillTokens: 200, contextWindow: 1_000 }, 800, "bodyAfterPrefix", true],
	["body-after-prefix respects hard cap", { activeContextTokens: 1_001, prefillTokens: 200, contextWindow: 1_000 }, 2_000, "bodyAfterPrefix", true],
	["missing prefix baseline still respects hard cap", { activeContextTokens: 200, contextWindow: 200 }, 2_000, "bodyAfterPrefix", true],
	["total scope respects hard cap", { activeContextTokens: 200, contextWindow: 200 }, undefined, "total", true],
] as const;

describe("Codex-style token scheduler", () => {
	test.each(cases)("%s", (_name, status, limit, scope, expected) => {
		expect(shouldAutoCompact({ status, limit, scope })).toBe(expected);
	});
});

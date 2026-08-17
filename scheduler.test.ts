import { describe, expect, test } from "vitest";
import { shouldAutoCompact } from "./scheduler.ts";

describe("Codex-style token scheduler", () => {
	test("uses the configured total scope", () => {
		expect(shouldAutoCompact({
			status: { activeContextTokens: 100, contextWindow: 200 },
			limit: 100,
			scope: "total",
		})).toBe(true);
	});

	test("subtracts the prefill baseline for body-after-prefix scope", () => {
		expect(shouldAutoCompact({
			status: { activeContextTokens: 150, prefillTokens: 100, contextWindow: 200 },
			limit: 49,
			scope: "bodyAfterPrefix",
		})).toBe(true);
	});

	test("does not use total tokens as the body-after-prefix scope", () => {
		expect(shouldAutoCompact({
			status: { activeContextTokens: 850, prefillTokens: 200, contextWindow: 1_000 },
			limit: 700,
			scope: "bodyAfterPrefix",
		})).toBe(false);
	});

	test("falls back to total scope when no prefix baseline is reliable", () => {
		expect(shouldAutoCompact({
			status: { activeContextTokens: 100, contextWindow: 200 },
			limit: 99,
			scope: "bodyAfterPrefix",
		})).toBe(true);
	});

	test("derives the omitted limit from 90 percent of the context window", () => {
		expect(shouldAutoCompact({
			status: { activeContextTokens: 180, contextWindow: 200 },
			scope: "total",
		})).toBe(true);
	});

	test("counts prefix tokens once for body-after-prefix and the hard cap", () => {
		expect(shouldAutoCompact({
			status: { activeContextTokens: 1_050, prefillTokens: 200, contextWindow: 1_000 },
			limit: 800,
			scope: "bodyAfterPrefix",
		})).toBe(true);
		expect(shouldAutoCompact({
			status: { activeContextTokens: 1_001, prefillTokens: 200, contextWindow: 1_000 },
			limit: 2_000,
			scope: "bodyAfterPrefix",
		})).toBe(true);
	});

	test("always respects the full context hard cap", () => {
		expect(shouldAutoCompact({
			status: { activeContextTokens: 200, contextWindow: 200 },
			scope: "total",
		})).toBe(true);
	});
});

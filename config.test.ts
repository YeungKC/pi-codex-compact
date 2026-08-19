import { describe, expect, test } from "vitest";
import { autoCompactTokenLimit, parseConfig } from "./config.ts";

describe("Codex compaction config", () => {
	test("parses supported settings", () => {
		expect(parseConfig({
			remoteCompactionV2: false,
			autoCompactTokenLimit: 128_000,
			autoCompactScope: "bodyAfterPrefix",
		})).toEqual({
			remoteCompactionV2: false,
			autoCompactTokenLimit: 128_000,
			autoCompactScope: "bodyAfterPrefix",
		});
	});

	test("clamps a configured limit to Codex's 90 percent cap", () => {
		expect(autoCompactTokenLimit({ remoteCompactionV2: true, autoCompactTokenLimit: 200, autoCompactScope: "total" }, 100)).toBe(90);
		expect(autoCompactTokenLimit({ remoteCompactionV2: true, autoCompactTokenLimit: 80, autoCompactScope: "total" }, 100)).toBe(80);
	});
});

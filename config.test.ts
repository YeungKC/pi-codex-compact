import { describe, expect, test } from "vitest";
import { parseConfig } from "./config.ts";

describe("Codex compaction config", () => {
	test("parses supported settings and ignores removed diagnostics", () => {
		expect(parseConfig({
			remoteCompactionV2: false,
			autoCompactTokenLimit: 128_000,
			autoCompactScope: "bodyAfterPrefix",
			debug: "verbose",
		})).toEqual({
			remoteCompactionV2: false,
			autoCompactTokenLimit: 128_000,
			autoCompactScope: "bodyAfterPrefix",
		});
	});
});

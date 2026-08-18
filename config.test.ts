import { describe, expect, test } from "vitest";
import { parseConfig } from "./config.ts";

describe("Codex compaction config", () => {
	test("accepts the verbose debug level", () => {
		expect(parseConfig({ debug: "verbose" })).toEqual({ debug: "verbose" });
	});

	test("ignores invalid debug levels", () => {
		expect(parseConfig({ debug: true })).toEqual({});
	});
});

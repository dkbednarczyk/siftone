import { describe, expect, test } from "bun:test";
import { formatDuration } from "./duration";

describe("formatDuration", () => {
	test("formats zero and sub-second durations", () => {
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(334)).toBe("334ms");
	});

	test("formats minutes, seconds, and milliseconds", () => {
		expect(formatDuration(94_334)).toBe("1m 34s 334ms");
	});

	test("rounds milliseconds across unit boundaries", () => {
		expect(formatDuration(999.5)).toBe("1s");
	});

	test("formats hours", () => {
		expect(formatDuration(3_661_001)).toBe("1h 1m 1s 1ms");
	});
});

import { describe, expect, test } from "bun:test";
import { mapBounded } from "./util";

describe("mapBounded", () => {
	test("waits for active work before rejecting", async () => {
		let release: (() => void) | undefined;
		const activeWork = new Promise<void>((resolve) => {
			release = resolve;
		});
		let activeWorkFinished = false;
		const result = mapBounded(
			["active", "fail"],
			async (value) => {
				if (value === "fail") {
					throw new Error("failed mapper");
				}

				await activeWork;
				activeWorkFinished = true;
				return value;
			},
			2,
		);

		await Promise.resolve();
		expect(activeWorkFinished).toBe(false);
		release?.();
		await expect(result).rejects.toThrow("failed mapper");
		expect(activeWorkFinished).toBe(true);
	});
});

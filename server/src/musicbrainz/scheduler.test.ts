import { describe, expect, test } from "bun:test";
import {
	createRateLimitedScheduler,
	createSerializedScheduler,
} from "./scheduler";

describe("MusicBrainz request schedulers", () => {
	test("spaces concurrent rate-limited tasks by the configured interval", async () => {
		let now = 0;
		const starts: number[] = [];
		const scheduler = createRateLimitedScheduler({
			clock: () => now,
			sleep: async (milliseconds) => {
				now += milliseconds;
			},
			minimumIntervalMs: 1_000,
		});

		await Promise.all([
			scheduler.run(async () => {
				starts.push(now);
			}),
			scheduler.run(async () => {
				starts.push(now);
			}),
			scheduler.run(async () => {
				starts.push(now);
			}),
		]);

		expect(starts).toEqual([0, 1_000, 2_000]);
	});

	test("continues serialized work after a failed task", async () => {
		const scheduler = createSerializedScheduler();
		const events: string[] = [];

		await expect(
			scheduler.run(async () => {
				events.push("first");
				throw new Error("expected failure");
			}),
		).rejects.toThrow("expected failure");
		await scheduler.run(async () => {
			events.push("second");
		});

		expect(events).toEqual(["first", "second"]);
	});
});

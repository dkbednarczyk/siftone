import { expect, test } from "bun:test";
import { HttpError, retryAfterMs, retryTransient } from "./retry";
import {
	createRateLimitedScheduler,
	createSerializedScheduler,
} from "./scheduler";

test("retries transient errors no more than three times", async () => {
	let calls = 0;
	const attempts: number[] = [];
	const delays: number[] = [];
	const value = await retryTransient({
		scheduler: createSerializedScheduler(),
		random: () => 0.5,
		onAttempt: (attempt) => {
			attempts.push(attempt);
		},
		sleep: async (delay) => {
			delays.push(delay);
		},
		task: async () => {
			calls += 1;
			if (calls < 3) {
				throw new HttpError(503);
			}
			return "ok";
		},
	});
	expect(value).toBe("ok");
	expect(calls).toBe(3);
	expect(attempts).toEqual([1, 2, 3]);
	expect(delays).toEqual([1000, 2000]);
});

test("does not delay after the final transient failure", async () => {
	const delays: number[] = [];
	const failure = new HttpError(503);

	await expect(
		retryTransient({
			scheduler: createSerializedScheduler(),
			maxAttempts: 1,
			sleep: async (delay) => {
				delays.push(delay);
			},
			task: async () => {
				throw failure;
			},
		}),
	).rejects.toBe(failure);
	expect(delays).toEqual([]);
});

test("honors Retry-After before retrying", async () => {
	const delays: number[] = [];
	let calls = 0;

	await retryTransient({
		scheduler: createSerializedScheduler(),
		sleep: async (delay) => {
			delays.push(delay);
		},
		task: async () => {
			calls += 1;
			if (calls === 1) {
				throw new HttpError(429, "2");
			}

			return "ok";
		},
	});

	expect(delays).toEqual([2000]);
});

test("does not retry non-transient HTTP errors", async () => {
	let calls = 0;
	await expect(
		retryTransient({
			scheduler: createSerializedScheduler(),
			task: async () => {
				calls += 1;
				throw new HttpError(404);
			},
		}),
	).rejects.toThrow("HTTP 404");
	expect(calls).toBe(1);
});

test("parses delta-seconds and HTTP-date Retry-After values", () => {
	const now = Date.parse("2026-07-16T00:00:00.000Z");

	expect(retryAfterMs("2", now)).toBe(2_000);
	expect(retryAfterMs("Wed, 16 Jul 2026 00:00:03 GMT", now)).toBe(3_000);
});

test("spaces retry attempts through the shared scheduler", async () => {
	let now = 0;
	const starts: number[] = [];
	const scheduler = createRateLimitedScheduler({
		clock: () => now,
		sleep: async (delay) => {
			now += delay;
		},
	});
	await expect(
		retryTransient({
			scheduler,
			sleep: async () => undefined,
			task: async () => {
				starts.push(now);
				throw new HttpError(503);
			},
		}),
	).rejects.toThrow();
	expect(starts).toEqual([0, 1000, 2000]);
});

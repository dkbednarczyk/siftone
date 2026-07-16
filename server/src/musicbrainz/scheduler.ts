export type Clock = () => number;
export type Sleep = (milliseconds: number) => Promise<void>;

export type TaskScheduler = Readonly<{
	run<T>(task: () => Promise<T>): Promise<T>;
}>;

export function createSerializedScheduler(): TaskScheduler {
	let tail = Promise.resolve();

	return {
		run<T>(task: () => Promise<T>): Promise<T> {
			const scheduled = tail.then(task, task);
			tail = scheduled.then(
				() => undefined,
				() => undefined,
			);

			return scheduled;
		},
	};
}

export function createRateLimitedScheduler({
	clock = Date.now,
	sleep = (milliseconds) => Bun.sleep(milliseconds),
	minimumIntervalMs = 1_000,
}: Readonly<{
	clock?: Clock;
	sleep?: Sleep;
	minimumIntervalMs?: number;
}> = {}): TaskScheduler {
	if (!Number.isSafeInteger(minimumIntervalMs) || minimumIntervalMs < 0) {
		throw new Error(
			"minimumIntervalMs must be a non-negative safe integer",
		);
	}

	let nextStartAt = 0;
	const serialized = createSerializedScheduler();

	return {
		run<T>(task: () => Promise<T>): Promise<T> {
			return serialized.run(async () => {
				const delay = Math.max(0, nextStartAt - clock());
				if (delay > 0) {
					await sleep(delay);
				}

				nextStartAt = clock() + minimumIntervalMs;

				return task();
			});
		},
	};
}

import type { TaskScheduler } from "./scheduler";

export class HttpError extends Error {
	readonly status: number;
	readonly retryAfter: string | null;

	constructor(status: number, retryAfter: string | null = null) {
		super(`HTTP ${status}`);
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

export function isTransient(error: unknown): boolean {
	if (error instanceof HttpError) {
		return (
			error.status === 408 || error.status === 429 || error.status >= 500
		);
	}

	return (
		error instanceof TypeError ||
		(error instanceof Error && error.name === "AbortError")
	);
}

export function retryAfterMs(
	value: string | null,
	now = Date.now(),
): number | undefined {
	if (value === null) {
		return undefined;
	}

	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return seconds * 1_000;
	}

	const date = Date.parse(value);

	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export async function retryTransient<T>({
	task,
	scheduler,
	maxAttempts = 3,
	sleep = (milliseconds) => Bun.sleep(milliseconds),
	random = Math.random,
	now = Date.now,
	onAttempt,
}: Readonly<{
	task: (attempt: number) => Promise<T>;
	scheduler: TaskScheduler;
	maxAttempts?: number;
	sleep?: (milliseconds: number) => Promise<void>;
	random?: () => number;
	now?: () => number;
	onAttempt?: (attempt: number) => void;
}>): Promise<T> {
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
		throw new Error("maxAttempts must be a positive safe integer");
	}

	let failure: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		onAttempt?.(attempt);
		try {
			return await scheduler.run(() => task(attempt));
		} catch (error) {
			failure = error;
			if (!isTransient(error) || attempt === maxAttempts) {
				throw error;
			}

			const retryAfter =
				error instanceof HttpError
					? retryAfterMs(error.retryAfter, now())
					: undefined;
			await sleep(
				retryAfter ??
					Math.round(1_000 * 2 ** (attempt - 1) * (0.5 + random())),
			);
		}
	}

	throw failure;
}

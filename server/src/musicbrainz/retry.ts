import pRetry from "p-retry";
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

function retryBackoffDelayMs(
	attemptNumber: number,
	random: () => number,
): number {
	return Math.round(1_000 * 2 ** (attemptNumber - 1) * (0.5 + random()));
}

class TransientRequestError extends Error {
	constructor(readonly originalError: unknown) {
		super("Transient request failure", { cause: originalError });
	}
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

	try {
		return await pRetry(
			async (attempt) => {
				onAttempt?.(attempt);
				try {
					return await scheduler.run(() => task(attempt));
				} catch (error) {
					if (isTransient(error)) {
						throw new TransientRequestError(error);
					}

					throw error;
				}
			},
			{
				retries: maxAttempts - 1,
				minTimeout: 0,
				maxTimeout: 0,
				onFailedAttempt: async ({
					error,
					attemptNumber,
					retriesLeft,
				}) => {
					if (
						!(error instanceof TransientRequestError) ||
						retriesLeft === 0
					) {
						return;
					}

					const originalError = error.originalError;

					const retryAfter =
						originalError instanceof HttpError
							? retryAfterMs(originalError.retryAfter, now())
							: undefined;

					await sleep(
						retryAfter ??
							retryBackoffDelayMs(attemptNumber, random),
					);
				},
				shouldRetry: ({ error }) =>
					error instanceof TransientRequestError,
			},
		);
	} catch (error) {
		if (error instanceof TransientRequestError) {
			throw error.originalError;
		}

		throw error;
	}
}

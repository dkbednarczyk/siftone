export type ReconciliationStatus = Readonly<{
	state: "idle" | "running" | "queued" | "backoff";
	lastStartedAt?: string;
	lastFinishedAt?: string;
	lastError?: string;
	nextRunAt?: string;
	reason?: string;
}>;

export type ReconciliationScheduler = Readonly<{
	request(): ReconciliationStatus;
	status(): ReconciliationStatus;
	close(): Promise<void>;
}>;

const MAX_BACKOFF_MS = 60 * 60 * 1_000;

/**
 * Runs complete source observations serially. Timer ticks and manual requests
 * coalesce rather than creating concurrent scans.
 */
export class SourceReconciliationSchedulerImpl {
	#timer: ReturnType<typeof setTimeout> | undefined;
	#running: Promise<void> | undefined;
	#queued = false;
	#closed = false;
	#failureCount = 0;
	#lastStartedAt: Date | undefined;
	#lastFinishedAt: Date | undefined;
	#lastError: string | undefined;
	#nextRunAt: Date | undefined;

	constructor(
		readonly intervalMs: number,
		readonly onReconcile: () => Promise<void>,
		readonly onFailure: (error: Error) => void,
	) {
		if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
			throw new RangeError(
				"Reconciliation interval must be a positive integer",
			);
		}
	}

	start(): void {
		this.#schedule(this.intervalMs);
	}

	request(): ReconciliationStatus {
		if (this.#closed) {
			return this.status();
		}

		if (this.#running !== undefined) {
			this.#queued = true;
			return this.status();
		}

		this.#clearTimer();
		this.#startRun();
		return this.status();
	}

	status(): ReconciliationStatus {
		const state =
			this.#running !== undefined
				? this.#queued
					? "queued"
					: "running"
				: this.#nextRunAt !== undefined && this.#failureCount > 0
					? "backoff"
					: "idle";

		return {
			state,
			lastStartedAt: this.#lastStartedAt?.toISOString(),
			lastFinishedAt: this.#lastFinishedAt?.toISOString(),
			lastError: this.#lastError,
			nextRunAt: this.#nextRunAt?.toISOString(),
		};
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#queued = false;
		this.#clearTimer();
		await this.#running;
	}

	#clearTimer(): void {
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}

		this.#nextRunAt = undefined;
	}

	#schedule(delayMs: number): void {
		if (this.#closed) {
			return;
		}

		this.#clearTimer();
		this.#nextRunAt = new Date(Date.now() + delayMs);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#nextRunAt = undefined;
			this.#startRun();
		}, delayMs);
	}

	#startRun(): void {
		if (this.#closed) {
			return;
		}

		if (this.#running !== undefined) {
			this.#queued = true;
			return;
		}

		this.#lastStartedAt = new Date();
		this.#running = this.#run();
		this.#schedule(this.intervalMs);
	}

	async #run(): Promise<void> {
		try {
			await this.onReconcile();
			this.#failureCount = 0;
			this.#lastError = undefined;
		} catch (error) {
			const failure =
				error instanceof Error ? error : new Error(String(error));
			this.#failureCount += 1;
			this.#lastError = failure.message;
			this.onFailure(failure);
		}

		this.#lastFinishedAt = new Date();
		this.#running = undefined;

		if (this.#closed) {
			return;
		}

		if (this.#queued) {
			this.#queued = false;
			this.#clearTimer();
			this.#startRun();
			return;
		}

		if (this.#failureCount > 0) {
			const failureMultiplier = 2 ** Math.min(this.#failureCount, 4);
			this.#schedule(
				Math.min(this.intervalMs * failureMultiplier, MAX_BACKOFF_MS),
			);
		}
	}
}

export function startSourceWatcher(
	options: Readonly<{
		intervalMs: number;
		onReconcile: () => Promise<void>;
		onFailure: (error: Error) => void;
	}>,
): ReconciliationScheduler {
	const scheduler = new SourceReconciliationSchedulerImpl(
		options.intervalMs,
		options.onReconcile,
		options.onFailure,
	);
	scheduler.start();
	return scheduler;
}

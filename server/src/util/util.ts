const DEFAULT_CONCURRENCY = 32;

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Maps values concurrently while preserving their input order. */
export async function mapBounded<T, R>(
	values: readonly T[],
	mapper: (value: T) => Promise<R>,
	concurrency = DEFAULT_CONCURRENCY,
): Promise<R[]> {
	if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
		throw new RangeError("Concurrency must be a positive safe integer");
	}

	const result = new Array<R>(values.length);
	let cursor = 0;
	let failed = false;
	let failure: unknown;
	const workers: Promise<void>[] = [];
	for (
		let worker = 0;
		worker < Math.min(concurrency, values.length);
		worker++
	) {
		workers.push(
			(async (): Promise<void> => {
				while (!failed) {
					const index = cursor++;
					if (index >= values.length) {
						return;
					}

					try {
						result[index] = await mapper(values[index]);
					} catch (error) {
						failed = true;
						failure = error;
					}
				}
			})(),
		);
	}
	await Promise.all(workers);
	if (failed) {
		throw failure;
	}

	return result;
}

import type { ImportState } from "../import-state";

export const nowNs = (): bigint => BigInt(Date.now()) * 1_000_000n;

export function immediate<T>(state: ImportState, work: () => T): T {
	state.database.run("BEGIN IMMEDIATE");
	try {
		const result = work();
		state.database.run("COMMIT");
		return result;
	} catch (error) {
		state.database.run("ROLLBACK");
		throw error;
	}
}

type SafeIntegerStatement<Row, Args extends readonly unknown[]> = Readonly<{
	safeIntegers(value: boolean): Readonly<{
		all(...values: Args): Row[];
		get(...values: Args): Row | null;
	}>;
}>;

function safeIntegerStatement<Row, Args extends readonly unknown[]>(
	statement: unknown,
): SafeIntegerStatement<Row, Args> {
	return statement as SafeIntegerStatement<Row, Args>;
}

export function bigintRows<Row, Args extends readonly unknown[]>(
	statement: unknown,
	...args: Args
): Row[] {
	return safeIntegerStatement<Row, Args>(statement)
		.safeIntegers(true)
		.all(...args);
}

export function bigintRow<Row, Args extends readonly unknown[]>(
	statement: unknown,
	...args: Args
): Row | null {
	return safeIntegerStatement<Row, Args>(statement)
		.safeIntegers(true)
		.get(...args);
}

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { PublicationInput } from "../publication/publish";
import { isCanonicalRelativePath } from "./canonical-path";
import { APPLICATION_ID, DATABASE_FILE, SCHEMA_SQL } from "./schema";

export { DATABASE_FILE } from "./schema";

export type ImportOperationPhase =
	| "planned"
	| "staged"
	| "tombstoned"
	| "published"
	| "attention_required";

export type ImportState = Readonly<{
	databasePath: string;
	database: Database;
	close(): void;
	isDegraded(): boolean;
	assertKnownExistingDestinations(
		inputs: readonly PublicationInput[],
	): Promise<void>;
	markReconciliationRequired(error?: string): void;
}>;

export class ImportStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ImportStateError";
	}
}

function configure(database: Database): void {
	database.run("PRAGMA foreign_keys = ON");
	database.run("PRAGMA journal_mode = WAL");
	database.run("PRAGMA busy_timeout = 5000");
	database.run("PRAGMA synchronous = NORMAL");
}

function createFreshSchema(database: Database): void {
	database.run(SCHEMA_SQL);
}

function schemaObjects(database: Database): unknown[] {
	return database
		.query<
			{
				type: string;
				name: string;
				tbl_name: string;
				sql: string | null;
			},
			[]
		>(
			"SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
		)
		.all();
}

let expectedSchema: unknown[] | undefined;
function expectedSchemaObjects(): unknown[] {
	if (expectedSchema !== undefined) return expectedSchema;
	const template = new Database(":memory:");
	configure(template);
	createFreshSchema(template);
	expectedSchema = schemaObjects(template);
	template.close();
	return expectedSchema;
}

export function validateImportStateSchema(database: Database): void {
	configure(database);
	const appId = database
		.query<{ application_id: number }, []>("PRAGMA application_id")
		.get();
	if (
		appId?.application_id !== APPLICATION_ID ||
		JSON.stringify(schemaObjects(database)) !==
			JSON.stringify(expectedSchemaObjects())
	) {
		throw new ImportStateError(
			"Incompatible SQLite library state; delete and recreate it instead of migrating",
		);
	}
}

function openAndValidateSchema(path: string): Database {
	const existed = existsSync(path);
	const database = new Database(path, { create: true, strict: true });
	try {
		configure(database);
		if (!existed) createFreshSchema(database);
		validateImportStateSchema(database);
		const check = database
			.query<{ quick_check: string }, []>("PRAGMA quick_check")
			.get();
		if (check?.quick_check !== "ok")
			throw new ImportStateError(
				`SQLite quick_check failed: ${check?.quick_check ?? "no result"}`,
			);
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

async function isEmptyDirectory(path: string): Promise<boolean> {
	return (await readdir(path)).length === 0;
}

/** Opens the destructive library-state database. SQLite itself serializes writers. */
export async function openImportState({
	stateRoot,
	generatedLibraryRoot,
}: Readonly<{
	stateRoot: string;
	generatedLibraryRoot: string;
}>): Promise<ImportState> {
	const databasePath = join(stateRoot, DATABASE_FILE);
	if (
		!existsSync(databasePath) &&
		!(await isEmptyDirectory(generatedLibraryRoot))
	) {
		throw new ImportStateError(
			"Generated-library root is non-empty but library state is absent; refusing to adopt output",
		);
	}

	const database = openAndValidateSchema(databasePath);
	return {
		databasePath,
		database,
		close: () => database.close(),
		markReconciliationRequired: (error?: string) => {
			database.run(
				"UPDATE reconciliation_state SET required = 1, last_error = ?, updated_at_ns = ? WHERE id = 1",
				[error ?? null, BigInt(Date.now()) * 1_000_000n],
			);
		},
		assertKnownExistingDestinations: async (inputs) => {
			for (const input of inputs) {
				const entry = input.entries[0];
				if (entry === undefined) {
					continue;
				}

				const destination = dirname(entry.destinationPath);
				const path = relative(
					generatedLibraryRoot,
					destination,
				).replaceAll("\\", "/");

				if (!isCanonicalRelativePath(path)) {
					throw new ImportStateError(
						`Unsafe generated destination: ${destination}`,
					);
				}

				const known = database
					.query<{ id: string }, [string]>(
						"SELECT id FROM published_destinations WHERE destination_path = ?",
					)
					.get(path);

				if (known === null && existsSync(destination)) {
					throw new ImportStateError(
						`Generated destination exists without SQLite ownership: ${destination}`,
					);
				}
			}
		},
		isDegraded: () =>
			database
				.query<{ degraded: number }, []>(
					"SELECT EXISTS(SELECT 1 FROM operations WHERE phase = 'attention_required') OR EXISTS(SELECT 1 FROM reviews WHERE kind = 'attention_required') OR EXISTS(SELECT 1 FROM reconciliation_state WHERE id = 1 AND required = 1) AS degraded",
				)
				.get()?.degraded === 1,
	};
}

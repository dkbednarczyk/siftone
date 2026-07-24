import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isMissingError } from "../util/path";
import { bigintRow } from "./reconcile/database";
import { APPLICATION_ID, DATABASE_FILE, SCHEMA_SQL } from "./schema";

export { DATABASE_FILE } from "./schema";

export type ImportOperationPhase =
	| "planned"
	| "staged"
	| "versioned"
	| "swapped"
	| "attention_required";

export type SourceManifestObservation = Readonly<{
	confirmed: boolean;
	unchanged: boolean;
}>;

export type ImportState = Readonly<{
	databasePath: string;
	database: Database;
	isTabulaRasa: boolean;
	close(): void;
	isDegraded(): boolean;
	reconciliationReason(watchRoot: string): string | undefined;
	isManifestReconciled(watchRoot: string, manifestHash: string): boolean;
	markManifestReconciled(watchRoot: string, manifestHash: string): void;
	recordScanIssue(message: string): void;
	clearScanIssue(): void;
	resetSourceObservationWindow(): void;
	observeSourceManifest(
		options: Readonly<{
			watchRoot: string;
			manifestHash: string;
			minimumAgeMs: number;
		}>,
	): SourceManifestObservation;
}>;

const SOURCE_OBSERVATION_QUERY =
	"SELECT confirmed_manifest_hash, pending_manifest_hash, pending_since_ns FROM source_observations WHERE root_path = ?";
const UPSERT_CONFIRMED_SOURCE_OBSERVATION =
	"INSERT INTO source_observations (root_path, confirmed_manifest_hash, pending_manifest_hash, pending_since_ns) VALUES (?, ?, NULL, NULL) ON CONFLICT(root_path) DO UPDATE SET confirmed_manifest_hash = excluded.confirmed_manifest_hash, pending_manifest_hash = NULL, pending_since_ns = NULL";
const UPSERT_PENDING_SOURCE_OBSERVATION =
	"INSERT INTO source_observations (root_path, confirmed_manifest_hash, pending_manifest_hash, pending_since_ns) VALUES (?, NULL, ?, ?) ON CONFLICT(root_path) DO UPDATE SET pending_manifest_hash = excluded.pending_manifest_hash, pending_since_ns = excluded.pending_since_ns";

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
	if (expectedSchema !== undefined) {
		return expectedSchema;
	}

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

	const schemaMatches =
		JSON.stringify(schemaObjects(database)) ===
		JSON.stringify(expectedSchemaObjects());

	if (appId?.application_id !== APPLICATION_ID || !schemaMatches) {
		throw new Error(
			"Incompatible SQLite library state; delete and recreate it instead of migrating",
		);
	}
}

function openAndValidateSchema(
	path: string,
	onProgress?: (message: string) => void,
): Database {
	const existed = existsSync(path);
	if (!existed) {
		onProgress?.(`Creating library state database at ${path}.`);
	}

	const database = new Database(path, { create: true, strict: true });

	try {
		configure(database);

		if (!existed) {
			createFreshSchema(database);
		}

		validateImportStateSchema(database);

		const check = database
			.query<{ quick_check: string }, []>("PRAGMA quick_check")
			.get();

		if (check?.quick_check !== "ok") {
			throw new Error(
				`SQLite quick_check failed: ${check?.quick_check ?? "no result"}`,
			);
		}

		if (!existed) {
			onProgress?.("Library state database is ready.");
		}

		return database;
	} catch (error) {
		database.close();

		throw error;
	}
}

async function isEmptyDirectory(path: string): Promise<boolean> {
	try {
		return (await readdir(path)).every((entry) => entry === ".siftone");
	} catch (error) {
		if (isMissingError(error)) {
			return true;
		}

		throw error;
	}
}

/** Opens the destructive library-state database. SQLite itself serializes writers. */
export async function openImportState({
	stateRoot,
	generatedLibraryRoot,
	versionRoot,
	onProgress,
}: Readonly<{
	stateRoot: string;
	generatedLibraryRoot: string;
	versionRoot: string;
	onProgress?: (message: string) => void;
}>): Promise<ImportState> {
	const databasePath = join(stateRoot, DATABASE_FILE);

	const rootsAreEmpty =
		(await isEmptyDirectory(generatedLibraryRoot)) &&
		(await isEmptyDirectory(versionRoot));

	if (!existsSync(databasePath) && !rootsAreEmpty) {
		throw new Error(
			"Generated-library or version root is non-empty but library state is absent; refusing to adopt output",
		);
	}

	const database = openAndValidateSchema(databasePath, onProgress);
	const isTabulaRasa =
		database
			.query<{ is_tabula_rasa: number }, []>(
				"SELECT NOT EXISTS(SELECT 1 FROM imports) AND NOT EXISTS(SELECT 1 FROM operations) AND (SELECT last_reconciled_manifest_hash FROM reconciliation_state WHERE id = 1) IS NULL AS is_tabula_rasa",
			)
			.get()?.is_tabula_rasa === 1;

	return {
		databasePath,
		database,
		isTabulaRasa,
		close: () => database.close(),
		isManifestReconciled: (watchRoot, manifestHash) =>
			database
				.query<{ reconciled: number }, [string, string, string]>(
					"SELECT last_reconciled_manifest_hash = ? AS reconciled FROM reconciliation_state WHERE id = 1 AND EXISTS(SELECT 1 FROM source_observations WHERE root_path = ? AND confirmed_manifest_hash = ?)",
				)
				.get(manifestHash, watchRoot, manifestHash)?.reconciled === 1,
		markManifestReconciled: (watchRoot, manifestHash) => {
			database.run(
				"UPDATE reconciliation_state SET last_reconciled_manifest_hash = ?, last_full_scan_at_ns = ? WHERE id = 1 AND EXISTS(SELECT 1 FROM source_observations WHERE root_path = ? AND confirmed_manifest_hash = ?)",
				[
					manifestHash,
					BigInt(Date.now()) * 1_000_000n,
					watchRoot,
					manifestHash,
				],
			);
		},
		recordScanIssue: (message) => {
			database.run(
				"UPDATE reconciliation_state SET last_scan_issue = ? WHERE id = 1",
				[message],
			);
		},
		clearScanIssue: () => {
			database.run(
				"UPDATE reconciliation_state SET last_scan_issue = NULL WHERE id = 1",
			);
		},
		resetSourceObservationWindow: () => {
			database.run(
				"UPDATE source_observations SET pending_manifest_hash = NULL, pending_since_ns = NULL",
			);
		},
		observeSourceManifest: ({ watchRoot, manifestHash, minimumAgeMs }) => {
			const now = BigInt(Date.now()) * 1_000_000n;
			const existing = bigintRow<
				{
					confirmed_manifest_hash: string | null;
					pending_manifest_hash: string | null;
					pending_since_ns: bigint | null;
				},
				[string]
			>(database.query(SOURCE_OBSERVATION_QUERY), watchRoot);
			const unchanged =
				existing?.confirmed_manifest_hash === manifestHash;
			const minimumAgeNs = BigInt(minimumAgeMs) * 1_000_000n;
			const confirmed =
				unchanged ||
				(existing?.pending_manifest_hash === manifestHash &&
					existing.pending_since_ns !== null &&
					now - existing.pending_since_ns >= minimumAgeNs);

			if (confirmed) {
				database.run(UPSERT_CONFIRMED_SOURCE_OBSERVATION, [
					watchRoot,
					manifestHash,
				]);
			} else if (existing?.pending_manifest_hash !== manifestHash) {
				database.run(UPSERT_PENDING_SOURCE_OBSERVATION, [
					watchRoot,
					manifestHash,
					now,
				]);
			}

			return { confirmed, unchanged };
		},
		isDegraded: () =>
			database
				.query<{ degraded: number }, []>(
					"SELECT EXISTS(SELECT 1 FROM operations WHERE phase = 'attention_required') OR EXISTS(SELECT 1 FROM reconciliation_state WHERE id = 1 AND last_scan_issue IS NOT NULL) AS degraded",
				)
				.get()?.degraded === 1,
		reconciliationReason: (watchRoot) => {
			const attentionRequired =
				database
					.query<{ required: number }, []>(
						"SELECT EXISTS(SELECT 1 FROM operations WHERE phase = 'attention_required') AS required",
					)
					.get()?.required === 1;
			if (attentionRequired) {
				return "publication operation requires review";
			}

			const scanIssue = database
				.query<{ last_scan_issue: string | null }, []>(
					"SELECT last_scan_issue FROM reconciliation_state WHERE id = 1",
				)
				.get()?.last_scan_issue;
			if (scanIssue !== null && scanIssue !== undefined) {
				return scanIssue;
			}

			const observation = database
				.query<
					{
						confirmed_manifest_hash: string | null;
						pending_manifest_hash: string | null;
						last_reconciled_manifest_hash: string | null;
					},
					[string]
				>(`
					SELECT so.confirmed_manifest_hash, so.pending_manifest_hash, rs.last_reconciled_manifest_hash
					FROM reconciliation_state rs
					LEFT JOIN source_observations so ON so.root_path = ?
					WHERE rs.id = 1
				`)
				.get(watchRoot);
			if (observation?.pending_manifest_hash !== null) {
				return "source snapshot awaiting confirmation";
			}
			if (
				observation?.confirmed_manifest_hash !== null &&
				observation?.confirmed_manifest_hash !==
					observation.last_reconciled_manifest_hash
			) {
				return "source reconciliation pending";
			}

			const pendingOperation =
				database
					.query<{ pending: number }, []>(
						"SELECT EXISTS(SELECT 1 FROM operations) AS pending",
					)
					.get()?.pending === 1;

			return pendingOperation
				? "publication operation pending"
				: undefined;
		},
	};
}

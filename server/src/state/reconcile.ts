import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, symlink } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { PublicationInput } from "../publication/publish";
import { mapBounded } from "../util/util";
import {
	canonicalRelativePath,
	isCanonicalRelativePath,
} from "./canonical-path";
import type { ImportState } from "./import-state";
import {
	ensureDestinationParent,
	ensurePublicationRoots,
	InvalidOperationState,
	isMissing,
	operationPaths,
} from "./operation-paths";
import { desiredFor, entriesMatch, manifestHash } from "./publication-snapshot";
import type { Desired, Entry, OperationRow } from "./reconcile-types";

const OPERATION_CONCURRENCY = 4;
const ENTRY_IO_CONCURRENCY = 8;

const MISSING_GRACE_NS = 7n * 24n * 60n * 60n * 1_000_000_000n;
const nowNs = (): bigint => BigInt(Date.now()) * 1_000_000n;

function containerKey(watchRoot: string, path: string): string {
	const normalized = path.replaceAll("\\", "/");
	return isAbsolute(path)
		? canonicalRelativePath(relative(watchRoot, path).replaceAll("\\", "/"))
		: isCanonicalRelativePath(normalized)
			? normalized
			: canonicalRelativePath(
					relative(watchRoot, path).replaceAll("\\", "/"),
				);
}

type Existing = {
	import_id: string;
	release_id: string;
	destination_path: string | null;
	manifest_hash: string;
	container_availability: "present" | "missing" | "inaccessible";
	release_availability: "present" | "missing" | "inaccessible";
};
type StoredEntry = {
	destination_name: string;
	source_path: string;
	relative_path: string;
	size: bigint;
	mtime_ns: bigint;
	kind: "audio" | "artwork";
};

function immediate<T>(state: ImportState, work: () => T): T {
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

function bigintRows<Row, Args extends readonly unknown[]>(
	statement: unknown,
	...args: Args
): Row[] {
	return safeIntegerStatement<Row, Args>(statement)
		.safeIntegers(true)
		.all(...args);
}

function bigintRow<Row, Args extends readonly unknown[]>(
	statement: unknown,
	...args: Args
): Row | null {
	return safeIntegerStatement<Row, Args>(statement)
		.safeIntegers(true)
		.get(...args);
}

function existingFor(
	state: ImportState,
	containerPath: string,
	logicalKey: string,
): Existing | null {
	return state.database
		.query<Existing, [string, string]>(`
		SELECT i.id AS import_id, sr.id AS release_id, pd.destination_path, i.manifest_hash, sc.availability AS container_availability, sr.availability AS release_availability
		FROM source_releases sr JOIN source_containers sc ON sc.id = sr.container_id
		LEFT JOIN imports i ON i.source_release_id = sr.id
		LEFT JOIN published_destinations pd ON pd.import_id = i.id
		WHERE sc.root_path = ? AND sr.logical_release_key = ?
	`)
		.get(containerPath, logicalKey);
}

function insertOrUpdateSourceFiles(
	state: ImportState,
	releaseId: string,
	entries: readonly Entry[],
): void {
	for (const entry of entries)
		state.database.run(
			`
		INSERT INTO source_files (source_path, source_release_id, relative_path, size, mtime_ns, kind)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(source_path) DO UPDATE SET source_release_id = excluded.source_release_id, relative_path = excluded.relative_path, size = excluded.size, mtime_ns = excluded.mtime_ns, kind = excluded.kind
	`,
			[
				entry.sourcePath,
				releaseId,
				entry.relativeSourcePath,
				entry.size,
				entry.mtimeNs,
				entry.kind,
			],
		);
}

function createOperation(
	state: ImportState,
	existing: Existing | null,
	desired: Desired | undefined,
	kind: OperationRow["kind"],
	oldDestination: string | null,
): OperationRow {
	if (existing === null && desired === undefined)
		throw new Error("New operation requires desired source data");
	const newDesired = desired;
	const id = randomUUID();
	const releaseId = existing?.release_id ?? randomUUID();
	const importId = existing?.import_id ?? randomUUID();
	const target = desired?.destinationPath ?? oldDestination;
	if (target === null || target === undefined)
		throw new Error("Operation needs a destination claim");
	const timestamp = nowNs();
	immediate(state, () => {
		if (existing === null) {
			if (newDesired === undefined)
				throw new Error("New operation requires desired source data");
			let container = state.database
				.query<{ id: string }, [string]>(
					"SELECT id FROM source_containers WHERE root_path = ?",
				)
				.get(newDesired.containerPath);
			if (container === null) {
				container = { id: randomUUID() };
				state.database.run(
					"INSERT INTO source_containers (id, root_path, availability, missing_since_ns, updated_at_ns) VALUES (?, ?, 'present', NULL, ?)",
					[container.id, newDesired.containerPath, timestamp],
				);
			}
			state.database.run(
				"INSERT INTO source_releases (id, container_id, logical_release_key, album_artist, album_title) VALUES (?, ?, ?, ?, ?)",
				[
					releaseId,
					container.id,
					newDesired.input.logicalReleaseKey,
					newDesired.input.albumArtist,
					newDesired.input.albumTitle,
				],
			);
			state.database.run(
				"INSERT INTO imports (id, source_release_id, manifest_hash, created_at_ns, updated_at_ns) VALUES (?, ?, ?, ?, ?)",
				[
					importId,
					releaseId,
					newDesired.manifestHash,
					timestamp,
					timestamp,
				],
			);
		} else if (desired !== undefined) {
			state.database.run(
				"UPDATE source_containers SET availability = 'present', missing_since_ns = NULL, updated_at_ns = ? WHERE id = (SELECT container_id FROM source_releases WHERE id = ?)",
				[timestamp, releaseId],
			);
			state.database.run(
				"UPDATE source_releases SET album_artist = ?, album_title = ?, availability = 'present', missing_since_ns = NULL, updated_at_ns = ? WHERE id = ?",
				[
					desired.input.albumArtist,
					desired.input.albumTitle,
					timestamp,
					releaseId,
				],
			);
		}
		if (desired !== undefined)
			insertOrUpdateSourceFiles(state, releaseId, desired.entries);
		state.database.run(
			"INSERT INTO operations (id, import_id, source_release_id, kind, phase, target_destination_path, staging_name, error_message, created_at_ns, updated_at_ns) VALUES (?, ?, ?, ?, 'planned', ?, ?, NULL, ?, ?)",
			[
				id,
				importId,
				releaseId,
				kind,
				target,
				`operation-${id}`,
				timestamp,
				timestamp,
			],
		);
		for (const path of new Set(
			[target, oldDestination].filter(
				(value): value is string => value !== null,
			),
		))
			state.database.run(
				"INSERT INTO operation_destination_claims (operation_id, destination_path) VALUES (?, ?)",
				[id, path],
			);
		if (desired !== undefined)
			for (const entry of desired.entries)
				state.database.run(
					"INSERT INTO operation_entries (operation_id, destination_name, source_path, size, mtime_ns, kind) VALUES (?, ?, ?, ?, ?, ?)",
					[
						id,
						entry.destinationName,
						entry.sourcePath,
						entry.size,
						entry.mtimeNs,
						entry.kind,
					],
				);
	});
	return {
		id,
		import_id: importId,
		source_release_id: releaseId,
		kind,
		phase: "planned",
		target_destination_path: target,
		staging_name: `operation-${id}`,
	};
}

function storedEntriesToEntries(
	watchRoot: string,
	rows: readonly StoredEntry[],
): Entry[] {
	return rows.map((row) => ({
		sourcePath: join(watchRoot, row.source_path),
		relativeSourcePath: row.relative_path,
		destinationName: row.destination_name,
		size: row.size,
		mtimeNs: row.mtime_ns,
		kind: row.kind,
	}));
}

function operationEntries(
	state: ImportState,
	operationId: string,
	watchRoot: string,
): Entry[] {
	const rows = bigintRows<StoredEntry, [string]>(
		state.database.query<StoredEntry, [string]>(`
		SELECT oe.destination_name, oe.source_path, sf.relative_path, oe.size, oe.mtime_ns, oe.kind
		FROM operation_entries oe JOIN source_files sf ON sf.source_path = oe.source_path
		WHERE oe.operation_id = ? ORDER BY oe.destination_name
	`),
		operationId,
	);
	return storedEntriesToEntries(watchRoot, rows);
}

async function stage(entries: readonly Entry[], path: string): Promise<void> {
	await rm(path, { recursive: true, force: true });
	await mapBounded(
		entries,
		async (entry) => {
			const status = await lstat(entry.sourcePath, { bigint: true });
			if (
				!status.isFile() ||
				status.isSymbolicLink() ||
				status.size !== entry.size ||
				status.mtimeNs !== entry.mtimeNs
			) {
				throw new Error(
					`Source changed after operation planning: ${entry.sourcePath}`,
				);
			}
		},
		ENTRY_IO_CONCURRENCY,
	);
	await mkdir(path, { recursive: true });
	await mapBounded(
		entries,
		(entry) => symlink(entry.sourcePath, join(path, entry.destinationName)),
		ENTRY_IO_CONCURRENCY,
	);
}

function updatePhase(
	state: ImportState,
	id: string,
	phase: OperationRow["phase"],
	error?: string,
): void {
	state.database.run(
		"UPDATE operations SET phase = ?, error_message = ?, updated_at_ns = ? WHERE id = ?",
		[phase, error ?? null, nowNs(), id],
	);
}

function priorDestination(state: ImportState, importId: string): string | null {
	return (
		state.database
			.query<{ destination_path: string }, [string]>(
				"SELECT destination_path FROM published_destinations WHERE import_id = ?",
			)
			.get(importId)?.destination_path ?? null
	);
}

function destinationEntries(
	state: ImportState,
	importId: string,
	watchRoot: string,
): Entry[] {
	const rows = bigintRows<StoredEntry, [string]>(
		state.database.query<StoredEntry, [string]>(`
		SELECT de.destination_name, de.source_path, sf.relative_path, de.size, de.mtime_ns, de.kind
		FROM destination_entries de JOIN published_destinations pd ON pd.id = de.destination_id
		JOIN source_files sf ON sf.source_path = de.source_path WHERE pd.import_id = ? ORDER BY de.destination_name
	`),
		importId,
	);
	return storedEntriesToEntries(watchRoot, rows);
}

type CurrentImport = Readonly<{
	import_id: string;
	release_id: string;
	root_path: string;
	logical_release_key: string;
	destination_path: string;
}>;

function currentImports(
	state: ImportState,
	observed?: readonly string[],
): CurrentImport[] {
	if (observed === undefined) {
		return state.database
			.query<CurrentImport, []>(`
				SELECT i.id AS import_id, sr.id AS release_id, sc.root_path, sr.logical_release_key, pd.destination_path
				FROM imports i
				JOIN source_releases sr ON sr.id = i.source_release_id
				JOIN source_containers sc ON sc.id = sr.container_id
				JOIN published_destinations pd ON pd.import_id = i.id
			`)
			.all();
	}

	return state.database
		.query<CurrentImport, [string]>(`
			SELECT i.id AS import_id, sr.id AS release_id, sc.root_path, sr.logical_release_key, pd.destination_path
			FROM json_each(?) observed
			JOIN source_containers sc ON sc.root_path = observed.value
			JOIN source_releases sr ON sr.container_id = sc.id
			JOIN imports i ON i.source_release_id = sr.id
			JOIN published_destinations pd ON pd.import_id = i.id
		`)
		.all(JSON.stringify(observed));
}

function finalizeOperation(
	state: ImportState,
	operation: OperationRow,
	entries: readonly Entry[],
	deleteImport: boolean,
): void {
	immediate(state, () => {
		if (deleteImport) {
			state.database.run("DELETE FROM operations WHERE id = ?", [
				operation.id,
			]);
			state.database.run("DELETE FROM imports WHERE id = ?", [
				operation.import_id,
			]);
			state.database.run("DELETE FROM source_releases WHERE id = ?", [
				operation.source_release_id,
			]);
			state.database.run(
				"DELETE FROM source_containers WHERE id NOT IN (SELECT DISTINCT container_id FROM source_releases)",
			);
			return;
		}
		let destination = state.database
			.query<{ id: string }, [string]>(
				"SELECT id FROM published_destinations WHERE import_id = ?",
			)
			.get(operation.import_id);
		if (destination === null) {
			const id = randomUUID();
			state.database.run(
				"INSERT INTO published_destinations (id, import_id, destination_path, published_at_ns) VALUES (?, ?, ?, ?)",
				[
					id,
					operation.import_id,
					operation.target_destination_path,
					nowNs(),
				],
			);
			destination = { id };
		} else
			state.database.run(
				"UPDATE published_destinations SET destination_path = ?, published_at_ns = ? WHERE id = ?",
				[operation.target_destination_path, nowNs(), destination.id],
			);
		state.database.run(
			"DELETE FROM destination_entries WHERE destination_id = ?",
			[destination.id],
		);
		const insertedEntries = state.database.run(
			`INSERT INTO destination_entries (destination_id, destination_name, source_path, size, mtime_ns, kind)
			SELECT ?, oe.destination_name, oe.source_path, oe.size, oe.mtime_ns, oe.kind
			FROM operation_entries oe
			JOIN source_files sf ON sf.source_path = oe.source_path
			WHERE oe.operation_id = ? AND sf.source_release_id = ?`,
			[destination.id, operation.id, operation.source_release_id],
		).changes;
		if (insertedEntries !== entries.length) {
			throw new Error("Frozen source file disappeared from state");
		}
		state.database.run(
			"DELETE FROM source_files WHERE source_release_id = ? AND source_path NOT IN (SELECT source_path FROM operation_entries WHERE operation_id = ?)",
			[operation.source_release_id, operation.id],
		);
		state.database.run(
			"UPDATE imports SET manifest_hash = ?, updated_at_ns = ? WHERE id = ?",
			[manifestHash(entries), nowNs(), operation.import_id],
		);
		state.database.run("DELETE FROM operations WHERE id = ?", [
			operation.id,
		]);
	});
}

async function executeOperation(
	state: ImportState,
	generatedLibraryRoot: string,
	stagingRoot: string,
	watchRoot: string,
	operation: OperationRow,
): Promise<void> {
	const entries = operationEntries(state, operation.id, watchRoot);
	const paths = operationPaths(
		generatedLibraryRoot,
		stagingRoot,
		operation.staging_name,
		operation.target_destination_path,
		operation.id,
	);
	const oldPath = priorDestination(state, operation.import_id);
	const oldFsPath =
		oldPath === null
			? null
			: operationPaths(
					generatedLibraryRoot,
					stagingRoot,
					operation.staging_name,
					oldPath,
					operation.id,
				).destination;
	try {
		if (
			operation.kind !== "delete" &&
			(await entriesMatch(paths.destination, entries))
		) {
			await rm(paths.staging, {
				recursive: true,
				force: true,
			});
			await rm(paths.tombstone, {
				recursive: true,
				force: true,
			});
			finalizeOperation(state, operation, entries, false);
			return;
		}
		if (operation.phase === "planned" && operation.kind !== "delete") {
			await stage(entries, paths.staging);
			updatePhase(state, operation.id, "staged");
			operation.phase = "staged";
		}
		if (operation.phase === "planned" && operation.kind === "delete") {
			updatePhase(state, operation.id, "staged");
			operation.phase = "staged";
		}
		if (
			operation.phase === "staged" &&
			oldFsPath !== null &&
			!(await isMissing(oldFsPath))
		) {
			await ensureDestinationParent(generatedLibraryRoot, oldFsPath);
			await ensureDestinationParent(
				generatedLibraryRoot,
				paths.tombstone,
			);
			const oldEntries = destinationEntries(
				state,
				operation.import_id,
				watchRoot,
			);
			if (
				operation.kind !== "repair" &&
				operation.kind !== "delete" &&
				!(await entriesMatch(oldFsPath, oldEntries))
			)
				throw new InvalidOperationState(
					`Refusing to replace drifted output: ${oldFsPath}`,
				);
			if (!(await isMissing(paths.tombstone)))
				throw new InvalidOperationState(
					`Tombstone exists: ${paths.tombstone}`,
				);
			await rename(oldFsPath, paths.tombstone);
			updatePhase(state, operation.id, "tombstoned");
			operation.phase = "tombstoned";
		}
		if (
			operation.phase === "staged" &&
			(oldFsPath === null || (await isMissing(oldFsPath)))
		) {
			if (
				oldFsPath !== null &&
				(await isMissing(paths.tombstone)) &&
				operation.kind !== "repair"
			)
				throw new InvalidOperationState(
					`Published destination disappeared before replacement: ${oldFsPath}`,
				);
			updatePhase(state, operation.id, "tombstoned");
			operation.phase = "tombstoned";
		}
		if (operation.phase === "tombstoned" && operation.kind !== "delete") {
			await ensureDestinationParent(
				generatedLibraryRoot,
				paths.destination,
			);
			if (!(await isMissing(paths.destination)))
				throw new InvalidOperationState(
					`Destination exists: ${paths.destination}`,
				);
			await rename(paths.staging, paths.destination);
			updatePhase(state, operation.id, "published");
			operation.phase = "published";
		}
		if (operation.phase === "tombstoned" && operation.kind === "delete") {
			await rm(paths.tombstone, {
				recursive: true,
				force: true,
			});
			finalizeOperation(state, operation, entries, true);
			return;
		}
		if (operation.phase === "published") {
			await rm(paths.tombstone, {
				recursive: true,
				force: true,
			});
			finalizeOperation(state, operation, entries, false);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof InvalidOperationState) {
			updatePhase(state, operation.id, "attention_required", message);
			state.database.run(
				"INSERT OR IGNORE INTO reviews (id, import_id, operation_id, kind, details_json, created_at_ns) VALUES (?, NULL, ?, 'attention_required', ?, ?)",
				[
					randomUUID(),
					operation.id,
					JSON.stringify({ message }),
					nowNs(),
				],
			);
		} else
			state.database.run(
				"UPDATE operations SET error_message = ?, updated_at_ns = ? WHERE id = ?",
				[message, nowNs(), operation.id],
			);
	}
}

export async function recoverInterruptedOperations({
	state,
	generatedLibraryRoot,
	stagingRoot,
	watchRoot,
}: Readonly<{
	state: ImportState;
	generatedLibraryRoot: string;
	stagingRoot: string;
	watchRoot: string;
}>): Promise<void> {
	await ensurePublicationRoots(generatedLibraryRoot, stagingRoot);

	const operations = state.database
		.query<OperationRow, []>(
			"SELECT id, import_id, source_release_id, kind, phase, target_destination_path, staging_name FROM operations WHERE phase <> 'attention_required' ORDER BY created_at_ns",
		)
		.all();

	await mapBounded(
		operations,
		(operation) =>
			executeOperation(
				state,
				generatedLibraryRoot,
				stagingRoot,
				watchRoot,
				operation,
			),
		OPERATION_CONCURRENCY,
	);
}

export async function reconcileImports({
	state,
	generatedLibraryRoot,
	stagingRoot,
	watchRoot,
	inputs,
	complete,
	incompleteSourceContainers = [],
	observedSourceContainers = [],
}: Readonly<{
	state: ImportState;
	generatedLibraryRoot: string;
	stagingRoot: string;
	watchRoot: string;
	inputs: readonly PublicationInput[];
	complete: boolean;
	incompleteSourceContainers?: readonly string[];
	observedSourceContainers?: readonly string[];
}>): Promise<void> {
	await ensurePublicationRoots(generatedLibraryRoot, stagingRoot);

	const desired = await mapBounded(inputs, (input) =>
		desiredFor(watchRoot, generatedLibraryRoot, input),
	);

	const desiredKeys = new Map<string, Set<string>>();
	const scheduled: OperationRow[] = [];
	for (const item of desired) {
		const releaseKeys =
			desiredKeys.get(item.containerPath) ?? new Set<string>();
		if (releaseKeys.has(item.input.logicalReleaseKey)) {
			throw new Error(
				`Duplicate source release: ${item.containerPath} (${item.input.logicalReleaseKey})`,
			);
		}

		releaseKeys.add(item.input.logicalReleaseKey);
		desiredKeys.set(item.containerPath, releaseKeys);
		const existing = existingFor(
			state,
			item.containerPath,
			item.input.logicalReleaseKey,
		);
		if (
			existing !== null &&
			state.database
				.query<{ id: string }, [string]>(
					"SELECT id FROM operations WHERE import_id = ?",
				)
				.get(existing.import_id) !== null
		) {
			continue;
		}

		if (existing === null) {
			scheduled.push(createOperation(state, null, item, "add", null));
		} else if (
			existing.destination_path !== item.destinationPath ||
			existing.manifest_hash !== item.manifestHash
		) {
			scheduled.push(
				createOperation(
					state,
					existing,
					item,
					"replace",
					existing.destination_path,
				),
			);
		} else if (
			!(await entriesMatch(
				item.destination,
				destinationEntries(state, existing.import_id, watchRoot),
			))
		) {
			scheduled.push(
				createOperation(
					state,
					existing,
					item,
					"repair",
					existing.destination_path,
				),
			);
		} else if (
			existing.container_availability !== "present" ||
			existing.release_availability !== "present"
		) {
			immediate(state, () => {
				const timestamp = nowNs();
				state.database.run(
					"UPDATE source_containers SET availability = 'present', missing_since_ns = NULL, updated_at_ns = ? WHERE root_path = ?",
					[timestamp, item.containerPath],
				);
				state.database.run(
					"UPDATE source_releases SET availability = 'present', missing_since_ns = NULL, updated_at_ns = ? WHERE id = ?",
					[timestamp, existing.release_id],
				);
			});
		}
	}

	if (complete || observedSourceContainers.length > 0) {
		const excluded = new Set(
			incompleteSourceContainers.map((path) =>
				containerKey(watchRoot, path),
			),
		);

		const observed = observedSourceContainers.map((path) =>
			containerKey(watchRoot, path),
		);

		const current = currentImports(state, complete ? undefined : observed);

		for (const row of current) {
			if (
				desiredKeys.get(row.root_path)?.has(row.logical_release_key) ===
					true ||
				excluded.has(row.root_path)
			) {
				continue;
			}

			if (
				state.database
					.query<{ id: string }, [string]>(
						"SELECT id FROM operations WHERE import_id = ?",
					)
					.get(row.import_id) !== null
			) {
				continue;
			}

			const missing = bigintRow<
				{ missing_since_ns: bigint | null },
				[string]
			>(
				state.database.query<
					{ missing_since_ns: bigint | null },
					[string]
				>("SELECT missing_since_ns FROM source_releases WHERE id = ?"),
				row.release_id,
			)?.missing_since_ns;

			const since = missing ?? nowNs();
			immediate(state, () =>
				state.database.run(
					"UPDATE source_releases SET availability = 'missing', missing_since_ns = COALESCE(missing_since_ns, ?), updated_at_ns = ? WHERE id = ?",
					[since, nowNs(), row.release_id],
				),
			);

			if (nowNs() - since >= MISSING_GRACE_NS) {
				scheduled.push(
					createOperation(
						state,
						{
							import_id: row.import_id,
							release_id: row.release_id,
							destination_path: row.destination_path,
							manifest_hash: "",
							container_availability: "missing",
							release_availability: "missing",
						},
						undefined,
						"delete",
						row.destination_path,
					),
				);
			}
		}

		if (complete) {
			state.database.run(
				"UPDATE reconciliation_state SET required = 0, last_full_scan_at_ns = ?, last_error = NULL, updated_at_ns = ? WHERE id = 1",
				[nowNs(), nowNs()],
			);
		}
	}
	await mapBounded(
		scheduled,
		(operation) =>
			executeOperation(
				state,
				generatedLibraryRoot,
				stagingRoot,
				watchRoot,
				operation,
			),
		OPERATION_CONCURRENCY,
	);
}

export async function reconcileSourceContainer(
	options: Omit<
		Parameters<typeof reconcileImports>[0],
		"complete" | "observedSourceContainers"
	> & { containerPath: string },
): Promise<void> {
	await reconcileImports({
		...options,
		complete: false,
		observedSourceContainers: [options.containerPath],
	});
}

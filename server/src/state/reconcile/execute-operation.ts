import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { mapBounded } from "../../util/util";
import type { ImportState } from "../import-state";
import {
	ensureDestinationParent,
	InvalidOperationState,
	isMissing,
	operationPaths,
} from "../operation-paths";
import { entriesMatch, manifestHash } from "../publication-snapshot";
import { immediate, nowNs } from "./database";
import {
	destinationEntries,
	operationEntries,
	priorDestination,
} from "./operation-entries";
import type { OperationRow, SourceEntry } from "./types";

const ENTRY_IO_CONCURRENCY = 8;

async function stage(
	entries: readonly SourceEntry[],
	path: string,
): Promise<void> {
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

function finalizeOperation(
	state: ImportState,
	operation: OperationRow,
	entries: readonly SourceEntry[],
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
		} else {
			state.database.run(
				"UPDATE published_destinations SET destination_path = ?, published_at_ns = ? WHERE id = ?",
				[operation.target_destination_path, nowNs(), destination.id],
			);
		}

		state.database.run(
			"DELETE FROM destination_entries WHERE destination_id = ?",
			[destination.id],
		);

		const insertedEntries = state.database.run(
			`INSERT INTO destination_entries (destination_id, destination_name, origin, source_path, cache_sha256, size, mtime_ns, kind)
			SELECT ?, oe.destination_name, 'source', oe.source_path, NULL, oe.size, oe.mtime_ns, oe.kind
			FROM operation_entries oe
			JOIN source_files sf ON sf.source_path = oe.source_path
			WHERE oe.operation_id = ? AND oe.origin = 'source' AND sf.source_release_id = ?`,
			[destination.id, operation.id, operation.source_release_id],
		).changes;

		if (insertedEntries !== entries.length) {
			throw new Error("Frozen source file disappeared from state");
		}

		state.database.run(
			"DELETE FROM source_files WHERE source_release_id = ? AND source_path NOT IN (SELECT source_path FROM operation_entries WHERE operation_id = ? AND origin = 'source')",
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

export async function executeOperation(
	state: ImportState,
	generatedLibraryRoot: string,
	stagingRoot: string,
	operation: OperationRow,
): Promise<void> {
	const entries = operationEntries(state, operation.id);
	const paths = operationPaths(
		generatedLibraryRoot,
		stagingRoot,
		operation.staging_path,
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
					operation.staging_path,
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

			const oldEntries = destinationEntries(state, operation.import_id);

			if (
				operation.kind !== "repair" &&
				operation.kind !== "delete" &&
				!(await entriesMatch(oldFsPath, oldEntries))
			) {
				throw new InvalidOperationState(
					`Refusing to replace drifted output: ${oldFsPath}`,
				);
			}

			if (!(await isMissing(paths.tombstone))) {
				throw new InvalidOperationState(
					`Tombstone exists: ${paths.tombstone}`,
				);
			}

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
			) {
				throw new InvalidOperationState(
					`Published destination disappeared before replacement: ${oldFsPath}`,
				);
			}

			updatePhase(state, operation.id, "tombstoned");

			operation.phase = "tombstoned";
		}

		if (operation.phase === "tombstoned" && operation.kind !== "delete") {
			await ensureDestinationParent(
				generatedLibraryRoot,
				paths.destination,
			);

			if (!(await isMissing(paths.destination))) {
				throw new InvalidOperationState(
					`Destination exists: ${paths.destination}`,
				);
			}

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

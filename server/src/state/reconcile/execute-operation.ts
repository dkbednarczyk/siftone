import { lstat, mkdir, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { ImportState } from "../import-state";
import {
	ensureDestinationParent,
	isMissing,
	isOwnedPublicLeaf,
	operationPaths,
	relativeVersionTarget,
} from "../operation-paths";
import { entriesMatch, manifestHash } from "../publication-snapshot";
import { immediate, nowNs } from "./database";
import { operationEntries } from "./operation-entries";
import type { Entry, OperationRow } from "./types";

type PriorVersion = Readonly<{
	destination_path: string;
	version_id: string;
	version_path: string;
}>;

async function stage(entries: readonly Entry[], path: string): Promise<void> {
	await rm(path, { recursive: true, force: true });

	for (const entry of entries) {
		const status = await lstat(entry.sourcePath, { bigint: true });
		if (!status.isFile() || status.isSymbolicLink()) {
			throw new Error(
				`Publication entry is not a real file: ${entry.sourcePath}`,
			);
		}
		if (status.size !== entry.size || status.mtimeNs !== entry.mtimeNs) {
			throw new Error(
				`Source changed after operation planning: ${entry.sourcePath}`,
			);
		}
	}

	await mkdir(path, { recursive: true });
	for (const entry of entries) {
		await symlink(entry.sourcePath, join(path, entry.destinationName));
	}
}

function updatePhase(
	state: ImportState,
	id: string,
	phase: OperationRow["phase"],
	error?: string,
): void {
	state.database.run(
		"UPDATE operations SET phase = ?, error_message = ? WHERE id = ?",
		[phase, error ?? null, id],
	);
}

function priorVersion(
	state: ImportState,
	importId: string,
): PriorVersion | null {
	return state.database
		.query<PriorVersion, [string]>(`
			SELECT i.destination_path, i.current_version_id AS version_id, av.version_path
			FROM imports i
			JOIN album_versions av ON av.id = i.current_version_id
			WHERE i.id = ?
		`)
		.get(importId);
}

function finalizeDelete(
	state: ImportState,
	operation: OperationRow,
	prior: PriorVersion,
): void {
	immediate(state, () => {
		state.database.run(
			"UPDATE album_versions SET state = 'retired', retired_at_ns = ? WHERE id = ? AND state = 'current'",
			[nowNs(), prior.version_id],
		);
		state.database.run("DELETE FROM operations WHERE id = ?", [
			operation.id,
		]);
		state.database.run("DELETE FROM imports WHERE id = ?", [
			operation.import_id,
		]);
		state.database.run(
			"DELETE FROM source_containers WHERE id NOT IN (SELECT DISTINCT container_id FROM imports)",
		);
	});
}

function finalizePublication(
	state: ImportState,
	operation: OperationRow,
	entries: readonly Entry[],
	prior: PriorVersion | null,
): void {
	if (operation.version_id === null) {
		throw new Error("Publication operation has no version identity");
	}

	immediate(state, () => {
		const promoted = state.database.run(
			"UPDATE album_versions SET state = 'current', retired_at_ns = NULL WHERE id = ? AND state = 'pending'",
			[operation.version_id],
		);
		if (promoted.changes !== 1) {
			throw new Error("Pending version cannot be promoted");
		}

		state.database.run(
			"UPDATE imports SET manifest_hash = ?, destination_path = ?, current_version_id = ? WHERE id = ?",
			[
				manifestHash(entries),
				operation.target_destination_path,
				operation.version_id,
				operation.import_id,
			],
		);

		state.database.run(
			"DELETE FROM destination_entries WHERE import_id = ?",
			[operation.import_id],
		);
		for (const entry of entries) {
			state.database.run(
				"INSERT INTO destination_entries (import_id, destination_name, source_path, size, mtime_ns, kind) VALUES (?, ?, ?, ?, ?, ?)",
				[
					operation.import_id,
					entry.destinationName,
					entry.sourcePath,
					entry.size,
					entry.mtimeNs,
					entry.kind,
				],
			);
		}

		state.database.run(
			"DELETE FROM source_files WHERE import_id = ? AND source_path NOT IN (SELECT source_path FROM operation_entries WHERE operation_id = ?)",
			[operation.import_id, operation.id],
		);
		if (prior !== null && prior.version_id !== operation.version_id) {
			state.database.run(
				"UPDATE album_versions SET state = 'retired', retired_at_ns = ? WHERE id = ? AND state = 'current'",
				[nowNs(), prior.version_id],
			);
		}
		state.database.run("DELETE FROM operations WHERE id = ?", [
			operation.id,
		]);
	});
}

async function removeOwnedTemporaryLink(
	temporaryLink: string,
	destination: string,
	version: string,
): Promise<void> {
	if (await isMissing(temporaryLink)) {
		return;
	}

	const target = relativeVersionTarget(destination, version);
	const status = await lstat(temporaryLink);
	if (!status.isSymbolicLink()) {
		throw new Error(`Temporary link is unsafe: ${temporaryLink}`);
	}

	const { readlink } = await import("node:fs/promises");
	if ((await readlink(temporaryLink)) !== target) {
		throw new Error(
			`Temporary link does not belong to operation: ${temporaryLink}`,
		);
	}
	await rm(temporaryLink, { force: false });
}

export async function executeOperation(
	state: ImportState,
	generatedLibraryRoot: string,
	stagingRoot: string,
	versionRoot: string,
	operation: OperationRow,
): Promise<void> {
	const entries = operationEntries(state, operation.id);
	const paths = operationPaths(
		generatedLibraryRoot,
		stagingRoot,
		versionRoot,
		operation.staging_path,
		operation.target_destination_path,
		operation.version_path,
		operation.id,
	);
	const prior = priorVersion(state, operation.import_id);

	try {
		if (operation.kind === "delete") {
			if (prior === null) {
				throw new Error("Delete operation has no published version");
			}
			if (operation.phase === "planned") {
				updatePhase(state, operation.id, "staged");
				operation.phase = "staged";
			}
			if (operation.phase === "staged") {
				if (!(await isMissing(prior.destination_path))) {
					if (
						!(await isOwnedPublicLeaf(
							prior.destination_path,
							prior.version_path,
							versionRoot,
						))
					) {
						throw new Error(
							`Refusing to delete unowned leaf: ${prior.destination_path}`,
						);
					}
					await rm(prior.destination_path, { force: false });
				}
				updatePhase(state, operation.id, "swapped");
				operation.phase = "swapped";
			}
			if (operation.phase === "swapped") {
				finalizeDelete(state, operation, prior);
			}

			return;
		}

		if (paths.version === null || operation.version_id === null) {
			throw new Error("Publication operation has no version identity");
		}
		const versionRecord = state.database
			.query<{ version_path: string }, [string, string]>(
				"SELECT version_path FROM album_versions WHERE id = ? AND origin_operation_id = ? AND state = 'pending'",
			)
			.get(operation.version_id, operation.id);
		if (versionRecord?.version_path !== paths.version) {
			throw new Error("Operation version record is invalid");
		}
		if (operation.phase === "planned") {
			await stage(entries, paths.staging);
			updatePhase(state, operation.id, "staged");
			operation.phase = "staged";
		}
		if (operation.phase === "staged") {
			if (await isMissing(paths.version)) {
				await rename(paths.staging, paths.version);
			} else if (!(await isMissing(paths.staging))) {
				throw new Error(
					`Version and staging both exist: ${paths.version}`,
				);
			}
			if (!(await entriesMatch(paths.version, entries))) {
				throw new Error(
					`Version does not match operation: ${paths.version}`,
				);
			}
			updatePhase(state, operation.id, "versioned");
			operation.phase = "versioned";
		}
		if (operation.phase === "versioned") {
			if (
				!(await isOwnedPublicLeaf(
					paths.destination,
					paths.version,
					versionRoot,
				))
			) {
				if (prior === null) {
					if (!(await isMissing(paths.destination))) {
						throw new Error(
							`Destination exists: ${paths.destination}`,
						);
					}
				} else {
					if (
						!(await isOwnedPublicLeaf(
							prior.destination_path,
							prior.version_path,
							versionRoot,
						))
					) {
						throw new Error(
							`Refusing to replace unowned leaf: ${prior.destination_path}`,
						);
					}
					if (
						prior.destination_path !== paths.destination &&
						!(await isMissing(paths.destination))
					) {
						throw new Error(
							`Destination exists: ${paths.destination}`,
						);
					}
				}

				await ensureDestinationParent(
					generatedLibraryRoot,
					paths.destination,
				);
				await removeOwnedTemporaryLink(
					paths.temporaryLink,
					paths.destination,
					paths.version,
				);
				await symlink(
					relativeVersionTarget(paths.destination, paths.version),
					paths.temporaryLink,
				);
				await rename(paths.temporaryLink, paths.destination);
			} else {
				await removeOwnedTemporaryLink(
					paths.temporaryLink,
					paths.destination,
					paths.version,
				);
			}
			updatePhase(state, operation.id, "swapped");
			operation.phase = "swapped";
		}
		if (operation.phase === "swapped") {
			if (
				prior !== null &&
				prior.destination_path !== paths.destination &&
				!(await isMissing(prior.destination_path))
			) {
				if (
					!(await isOwnedPublicLeaf(
						prior.destination_path,
						prior.version_path,
						versionRoot,
					))
				) {
					throw new Error(
						`Refusing to remove unowned prior leaf: ${prior.destination_path}`,
					);
				}
				await rm(prior.destination_path, { force: false });
			}
			if (
				!(await isOwnedPublicLeaf(
					paths.destination,
					paths.version,
					versionRoot,
				))
			) {
				throw new Error(
					`Published leaf is not owned: ${paths.destination}`,
				);
			}
			finalizePublication(state, operation, entries, prior);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof Error) {
			updatePhase(state, operation.id, "attention_required", message);
		} else {
			state.database.run(
				"UPDATE operations SET error_message = ? WHERE id = ?",
				[message, operation.id],
			);
		}
		throw error;
	}
}

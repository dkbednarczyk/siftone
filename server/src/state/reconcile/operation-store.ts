import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ImportState } from "../import-state";
import { immediate, nowNs } from "./database";
import type { Desired, OperationRow, SourceEntry } from "./types";

export type Existing = {
	import_id: string;
	destination_path: string | null;
	version_path: string | null;
	manifest_hash: string;
	availability: "present" | "missing";
};

export function existingFor(
	state: ImportState,
	containerPath: string,
	logicalKey: string,
): Existing | null {
	return state.database
		.query<Existing, [string, string]>(`
		SELECT i.id AS import_id, i.destination_path, av.version_path, i.manifest_hash, i.availability
		FROM imports i
		JOIN source_containers sc ON sc.id = i.container_id
		LEFT JOIN album_versions av ON av.id = i.current_version_id
		WHERE sc.root_path = ? AND i.logical_release_key = ?
	`)
		.get(containerPath, logicalKey);
}

function insertOrUpdateSourceFiles(
	state: ImportState,
	importId: string,
	entries: readonly SourceEntry[],
): void {
	for (const entry of entries) {
		state.database.run(
			`
		INSERT INTO source_files (source_path, import_id)
		VALUES (?, ?)
		ON CONFLICT(source_path) DO UPDATE SET import_id = excluded.import_id
	`,
			[entry.sourcePath, importId],
		);
	}
}

export function createOperation(
	state: ImportState,
	existing: Existing | null,
	desired: Desired | undefined,
	stagingRoot: string,
	versionRoot: string,
	kind: OperationRow["kind"],
	oldDestination: string | null,
): OperationRow {
	if (existing === null && desired === undefined) {
		throw new Error("New operation requires desired source data");
	}

	const newDesired = desired;
	const id = randomUUID();

	const importId = existing?.import_id ?? randomUUID();

	const target = desired?.destinationPath ?? oldDestination;

	if (target === null || target === undefined) {
		throw new Error("Operation needs a destination claim");
	}

	const timestamp = nowNs();
	const versionId = kind === "delete" ? null : randomUUID();
	const versionPath =
		versionId === null ? null : join(versionRoot, `operation-${id}`);
	immediate(state, () => {
		if (existing === null) {
			if (newDesired === undefined) {
				throw new Error("New operation requires desired source data");
			}

			let container = state.database
				.query<{ id: string }, [string]>(
					"SELECT id FROM source_containers WHERE root_path = ?",
				)
				.get(newDesired.containerPath);

			if (container === null) {
				container = { id: randomUUID() };
				state.database.run(
					"INSERT INTO source_containers (id, root_path) VALUES (?, ?)",
					[container.id, newDesired.containerPath],
				);
			}

			state.database.run(
				"INSERT INTO imports (id, container_id, logical_release_key, manifest_hash, availability, destination_path, current_version_id) VALUES (?, ?, ?, ?, 'present', NULL, NULL)",
				[
					importId,
					container.id,
					newDesired.input.logicalReleaseKey,
					newDesired.manifestHash,
				],
			);
		} else if (desired !== undefined) {
			state.database.run(
				"UPDATE imports SET availability = 'present' WHERE id = ?",
				[importId],
			);
		}

		if (desired !== undefined) {
			insertOrUpdateSourceFiles(state, importId, desired.entries);
		}

		if (versionId !== null && versionPath !== null) {
			state.database.run(
				"INSERT INTO album_versions (id, origin_operation_id, version_path, state, retired_at_ns) VALUES (?, ?, ?, 'pending', NULL)",
				[versionId, id, versionPath],
			);
		}

		state.database.run(
			"INSERT INTO operations (id, import_id, kind, phase, target_destination_path, staging_path, version_id, version_path, error_message, created_at_ns) VALUES (?, ?, ?, 'planned', ?, ?, ?, ?, NULL, ?)",
			[
				id,
				importId,
				kind,
				target,
				join(stagingRoot, `operation-${id}`),
				versionId,
				versionPath,
				timestamp,
			],
		);

		for (const path of new Set(
			[target, oldDestination].filter(
				(value): value is string => value !== null,
			),
		)) {
			state.database.run(
				"INSERT INTO operation_destination_claims (operation_id, destination_path) VALUES (?, ?)",
				[id, path],
			);
		}

		if (desired !== undefined) {
			for (const entry of desired.entries) {
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
			}
		}
	});

	return {
		id,
		import_id: importId,
		kind,
		phase: "planned",
		target_destination_path: target,
		staging_path: join(stagingRoot, `operation-${id}`),
		version_id: versionId,
		version_path: versionPath,
	};
}
